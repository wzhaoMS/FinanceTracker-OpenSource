import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Interleavings for sign-in: verifyPassword is paused after scrypt finishes,
 * while the server changes the credential, then released. The login must
 * not create a session for a credential that no longer exists.
 */

const gate = vi.hoisted(() => ({
  hold: null as null | { reached: () => void; release: Promise<void> },
}));

vi.mock('./auth/password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth/password.js')>();
  return {
    ...actual,
    verifyPassword: async (password: string, stored: string) => {
      const result = await actual.verifyPassword(password, stored);
      const hold = gate.hold;
      if (hold) {
        gate.hold = null;
        hold.reached();
        await hold.release;
      }
      return result;
    },
  };
});

import { createApp } from './app.js';
import { hashPassword, type ScryptParams } from './auth/password.js';
import type { LocalAuthRepo } from './services/localAuthRepo.js';
import { SqliteStateRepo } from './services/sqliteStateRepo.js';
import { listenLoopback } from './testing/loopback.js';

const FAST: ScryptParams = { ln: 10, r: 8, p: 1 };
const ORIGIN = 'http://127.0.0.1:5173';
const PASSWORD = 'correct horse battery';

let repo: SqliteStateRepo | null = null;

afterEach(() => {
  gate.hold = null;
  repo?.close();
  repo = null;
});

async function build(scryptParams: ScryptParams = FAST): Promise<{ app: Express; users: LocalAuthRepo }> {
  repo = new SqliteStateRepo({ file: ':memory:' });
  const { app, users } = createApp({
    repo,
    serviceToken: 'ab'.repeat(32),
    allowedOrigins: [ORIGIN],
    snapshotsEnabled: false,
    scryptParams,
    log: () => undefined,
  });
  users.createUser('alex', await hashPassword(PASSWORD, FAST));
  return { app, users };
}

function pauseNextVerification(): { reached: Promise<void>; release: () => void } {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  gate.hold = { reached, release: new Promise<void>((resolve) => { release = resolve; }) };
  return { reached: reachedPromise, release };
}

async function signIn(app: Express, password = PASSWORD) {
  return request(await listenLoopback(app)).post('/auth/login').set('Origin', ORIGIN).set('X-Holdr-Request', '1')
    .send({ username: 'alex', password });
}

function sessionCount(): number {
  return (repo!.internalGetDb().prepare('SELECT COUNT(*) AS n FROM local_sessions').get() as { n: number }).n;
}

describe('sign-in racing a credential change', () => {
  it('a password reset during verification refuses the old-password login', async () => {
    const { app, users } = await build();
    const pause = pauseNextVerification();
    const login = signIn(app);
    await pause.reached;
    users.setPasswordHash('alex', await hashPassword('a brand new password', FAST), { revokeSessions: true });
    pause.release();
    const res = await login;
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid username or password' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(sessionCount()).toBe(0);
    expect((await signIn(app)).status).toBe(401);
    expect((await signIn(app, 'a brand new password')).status).toBe(200);
  });

  it('a user removed during verification gets 401, not a session or a 500', async () => {
    const { app, users } = await build();
    const pause = pauseNextVerification();
    const login = signIn(app);
    await pause.reached;
    users.removeUser('alex');
    pause.release();
    const res = await login;
    expect(res.status).toBe(401);
    expect(sessionCount()).toBe(0);
  });

  it('the opportunistic rehash never overwrites a password set meanwhile', async () => {
    const { app, users } = await build({ ln: 11, r: 8, p: 1 });
    const replacement = await hashPassword('set by holdr-user passwd', FAST);
    const pause = pauseNextVerification();
    const login = signIn(app);
    await pause.reached;
    users.setPasswordHash('alex', replacement, { revokeSessions: false });
    pause.release();
    expect((await login).status).toBe(401);
    expect(users.findUser('alex')!.passwordHash).toBe(replacement);
    expect(sessionCount()).toBe(0);
  });

  it('without interference the paused login still succeeds and upgrades the hash', async () => {
    const { app, users } = await build({ ln: 11, r: 8, p: 1 });
    const pause = pauseNextVerification();
    const login = signIn(app);
    await pause.reached;
    pause.release();
    const res = await login;
    expect(res.status).toBe(200);
    expect(sessionCount()).toBe(1);
    expect(users.findUser('alex')!.passwordHash.startsWith('$scrypt$ln=11,')).toBe(true);
  });
});
