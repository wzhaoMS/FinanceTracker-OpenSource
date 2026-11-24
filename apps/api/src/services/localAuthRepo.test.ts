import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import { SqliteStateRepo } from './sqliteStateRepo.js';
import { LocalAuthRepo, UserExistsError, normalizeUsername, usernameProblem } from './localAuthRepo.js';
import { hashToken } from './authRepo.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-10-16T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

let state: SqliteStateRepo;
let users: LocalAuthRepo;

beforeEach(() => {
  state = new SqliteStateRepo({ file: ':memory:' });
  users = new LocalAuthRepo(state);
});

afterEach(() => {
  state.close();
});

function rows(sql: string): unknown[] {
  return state.internalGetDb().prepare(sql).all();
}

describe('local auth schema', () => {
  it('adds the tables idempotently to an existing database without changing user_version', async () => {
    const dir = await makeScratchDir('local-auth-');
    try {
      const file = path.join(dir, 'finance.db');
      const first = new SqliteStateRepo({ file });
      const version = first.schemaVersion();
      // Simulate a database written by a build that predates local sign-in.
      first.internalGetDb().exec('DROP TABLE local_sessions; DROP TABLE local_users;');
      first.close();

      const reopened = new SqliteStateRepo({ file });
      expect(reopened.schemaVersion()).toBe(version);
      const tables = reopened.internalGetDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'local_%' ORDER BY name")
        .all();
      expect(tables).toEqual([{ name: 'local_sessions' }, { name: 'local_users' }]);
      reopened.close();
      const again = new SqliteStateRepo({ file });
      expect(again.schemaVersion()).toBe(version);
      again.close();
    } finally {
      await removeScratchDir(dir);
    }
  });

  it('adds local_sessions.secure to a session table created before it existed', async () => {
    const dir = await makeScratchDir('local-auth-');
    try {
      const file = path.join(dir, 'finance.db');
      const first = new SqliteStateRepo({ file });
      const db = first.internalGetDb();
      db.exec(`DROP TABLE local_sessions;
        CREATE TABLE local_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL, renewed_at TEXT NOT NULL);`);
      const alex = new LocalAuthRepo(first).createUser('alex', 'h', T0);
      db.prepare('INSERT INTO local_sessions (id, user_id, created_at, expires_at, renewed_at) VALUES (?, ?, ?, ?, ?)')
        .run(hashToken('old-token'), alex.id, T0.toISOString(), at(DAY).toISOString(), T0.toISOString());
      first.close();

      const reopened = new SqliteStateRepo({ file });
      const upgraded = new LocalAuthRepo(reopened);
      expect(upgraded.findSession('old-token', T0)).toMatchObject({ username: 'alex', secure: false });
      expect(upgraded.findSession('old-token', T0, { secureOnly: true })).toBeNull();
      reopened.close();
    } finally {
      await removeScratchDir(dir);
    }
  });

  it('only accepts lowercase usernames at the database level', () => {
    expect(() =>
      state.internalGetDb()
        .prepare("INSERT INTO local_users (id, username, password_hash) VALUES ('x', 'Alex', 'h')")
        .run(),
    ).toThrow(/CHECK/);
  });

  it('leaves the dormant Google-OAuth users table untouched', () => {
    users.createUser('alex', 'hash', T0);
    expect(rows('SELECT * FROM users')).toEqual([]);
  });
});

describe('usernames', () => {
  it('normalizes case and surrounding whitespace', () => {
    expect(normalizeUsername('  Alex ')).toBe('alex');
  });

  it('allows short lowercase handles only', () => {
    for (const ok of ['alex', 'casey', 'e2e', 'a', 'alex.sample', 'x_s-1']) expect(usernameProblem(ok), ok).toBeNull();
    for (const bad of ['', 'Alex', '-alex', '.alex', 'alex sample', 'alex@home', 'a'.repeat(33), 'zoë']) {
      expect(usernameProblem(bad), bad).not.toBeNull();
    }
  });
});

describe('LocalAuthRepo users', () => {
  it('creates, finds, lists and removes users', () => {
    expect(users.countUsers()).toBe(0);
    const alex = users.createUser('alex', 'hash-w', T0);
    users.createUser('casey', 'hash-x', at(1000));
    expect(alex.id).toMatch(/^lu_[0-9a-f]{16}$/);
    expect(users.findUser('alex')).toMatchObject({ id: alex.id, username: 'alex', passwordHash: 'hash-w' });
    expect(users.findUser('nobody')).toBeNull();
    users.createSession(alex.id, DAY, T0);
    expect(users.listUsers(T0)).toEqual([
      { id: alex.id, username: 'alex', createdAt: T0.toISOString(), updatedAt: T0.toISOString(), activeSessions: 1 },
      expect.objectContaining({ username: 'casey', activeSessions: 0 }),
    ]);
    expect(JSON.stringify(users.listUsers(T0))).not.toContain('hash-');
    expect(users.removeUser('casey')).toBe(true);
    expect(users.removeUser('casey')).toBe(false);
    expect(users.countUsers()).toBe(1);
  });

  it('rejects duplicates and invalid names', () => {
    users.createUser('alex', 'hash', T0);
    expect(() => users.createUser('alex', 'other', T0)).toThrow(UserExistsError);
    expect(() => users.createUser('Not Valid', 'hash', T0)).toThrow(/username/);
  });

  it('ends every session of a user when they are removed', () => {
    const alex = users.createUser('alex', 'hash', T0);
    const { token } = users.createSession(alex.id, DAY, T0);
    users.removeUser('alex');
    expect(users.findSession(token, T0)).toBeNull();
    expect(rows('SELECT * FROM local_sessions')).toEqual([]);
  });

  it('a password change can sign the user out everywhere', () => {
    const alex = users.createUser('alex', 'old', T0);
    const casey = users.createUser('casey', 'x', T0);
    users.createSession(alex.id, DAY, T0);
    users.createSession(alex.id, DAY, T0);
    const other = users.createSession(casey.id, DAY, T0);
    expect(users.setPasswordHash('alex', 'new', { revokeSessions: true }, at(5))).toEqual({ revokedSessions: 2 });
    expect(users.findUser('alex')).toMatchObject({ passwordHash: 'new', updatedAt: at(5).toISOString() });
    expect(users.findSession(other.token, T0)?.username).toBe('casey');
    const kept = users.createSession(alex.id, DAY, T0);
    expect(users.setPasswordHash('alex', 'rehashed', { revokeSessions: false }, T0)).toEqual({ revokedSessions: 0 });
    expect(users.findSession(kept.token, T0)?.username).toBe('alex');
    expect(users.setPasswordHash('ghost', 'x', { revokeSessions: true }, T0)).toBeNull();
  });
});

describe('LocalAuthRepo sessions', () => {
  it('hands out a 32-byte token once and stores only its sha256', () => {
    const alex = users.createUser('alex', 'hash', T0);
    const { token, expiresAt } = users.createSession(alex.id, 30 * DAY, T0);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBe(at(30 * DAY).toISOString());
    const stored = rows('SELECT id, user_id FROM local_sessions') as Array<{ id: string; user_id: string }>;
    expect(stored).toEqual([{ id: hashToken(token), user_id: alex.id }]);
    expect(JSON.stringify(rows('SELECT * FROM local_sessions'))).not.toContain(token);
    expect(users.findSession(token, T0)).toMatchObject({ userId: alex.id, username: 'alex', expiresAt });
  });

  it('treats unknown, empty and expired tokens as signed out and deletes expired rows', () => {
    const alex = users.createUser('alex', 'hash', T0);
    const { token } = users.createSession(alex.id, DAY, T0);
    expect(users.findSession('', T0)).toBeNull();
    expect(users.findSession('0'.repeat(64), T0)).toBeNull();
    expect(users.findSession(token, at(DAY - 1))).not.toBeNull();
    expect(users.findSession(token, at(DAY))).toBeNull();
    expect(rows('SELECT * FROM local_sessions')).toEqual([]);
  });

  it('slides the expiry forward on renewal', () => {
    const alex = users.createUser('alex', 'hash', T0);
    const { token } = users.createSession(alex.id, DAY, T0);
    const session = users.findSession(token, at(DAY - 10))!;
    expect(users.renewSession(session.id, DAY, at(DAY - 10))).toBe(at(2 * DAY - 10).toISOString());
    expect(users.findSession(token, at(2 * DAY - 11))).toMatchObject({ renewedAt: at(DAY - 10).toISOString() });
  });

  it('deletes sessions on logout and reaps expired ones', () => {
    const alex = users.createUser('alex', 'hash', T0);
    const short = users.createSession(alex.id, 1000, T0);
    const long = users.createSession(alex.id, DAY, T0);
    expect(users.deleteSession(long.token)).toBe(true);
    expect(users.deleteSession(long.token)).toBe(false);
    users.createSession(alex.id, DAY, T0);
    expect(users.reapExpiredSessions(at(1000))).toBe(1);
    expect(users.findSession(short.token, T0)).toBeNull();
    expect(rows('SELECT * FROM local_sessions')).toHaveLength(1);
  });
});

describe('LocalAuthRepo.startSession', () => {
  it('creates the session only while the verified hash is still current', () => {
    const alex = users.createUser('alex', 'verified-hash', T0);
    const started = users.startSession({ userId: alex.id, verifiedPasswordHash: 'verified-hash', ttlMs: DAY, now: T0 });
    expect(users.findSession(started!.token, T0)?.username).toBe('alex');
    users.setPasswordHash('alex', 'reset-hash', { revokeSessions: true }, T0);
    expect(users.startSession({ userId: alex.id, verifiedPasswordHash: 'verified-hash', ttlMs: DAY, now: T0 })).toBeNull();
    expect(rows('SELECT * FROM local_sessions')).toEqual([]);
  });

  it('refuses a removed user', () => {
    const alex = users.createUser('alex', 'verified-hash', T0);
    users.removeUser('alex');
    expect(users.startSession({ userId: alex.id, verifiedPasswordHash: 'verified-hash', ttlMs: DAY, now: T0 })).toBeNull();
  });

  it('swaps in a rehash and ends the replaced session in the same step', () => {
    const alex = users.createUser('alex', 'weak-hash', T0);
    const old = users.createSession(alex.id, DAY, T0);
    const fresh = users.startSession({
      userId: alex.id, verifiedPasswordHash: 'weak-hash', rehashedPasswordHash: 'strong-hash',
      replaceToken: old.token, ttlMs: DAY, now: at(5),
    });
    expect(fresh).not.toBeNull();
    expect(users.findUser('alex')).toMatchObject({ passwordHash: 'strong-hash', updatedAt: at(5).toISOString() });
    expect(users.findSession(old.token, T0)).toBeNull();
    expect(rows('SELECT * FROM local_sessions')).toHaveLength(1);
  });

  it('never applies a rehash over a different hash, and changes nothing when refused', () => {
    const alex = users.createUser('alex', 'reset-hash', T0);
    const other = users.createSession(alex.id, DAY, T0);
    expect(users.startSession({
      userId: alex.id, verifiedPasswordHash: 'weak-hash', rehashedPasswordHash: 'strong-hash',
      replaceToken: other.token, ttlMs: DAY, now: T0,
    })).toBeNull();
    expect(users.findUser('alex')!.passwordHash).toBe('reset-hash');
    expect(users.findSession(other.token, T0)?.username).toBe('alex');
  });
});

describe('LocalAuthRepo secure sessions', () => {
  it('records how a session was issued; HTTPS mode drops plain-HTTP sessions', () => {
    const alex = users.createUser('alex', 'h', T0);
    const plain = users.startSession({ userId: alex.id, verifiedPasswordHash: 'h', ttlMs: DAY, now: T0 })!;
    const secure = users.startSession({ userId: alex.id, verifiedPasswordHash: 'h', ttlMs: DAY, now: T0, secure: true })!;
    expect(users.findSession(secure.token, T0, { secureOnly: true })).toMatchObject({ username: 'alex', secure: true });
    expect(users.findSession(plain.token, T0)).toMatchObject({ username: 'alex', secure: false });
    expect(users.findSession(plain.token, T0, { secureOnly: true })).toBeNull();
    expect(users.findSession(plain.token, T0)).toBeNull();

    const another = users.createSession(alex.id, DAY, T0);
    expect(users.deleteInsecureSessions()).toBe(1);
    expect(users.findSession(another.token, T0)).toBeNull();
    expect(users.findSession(secure.token, T0)?.secure).toBe(true);
    expect(() => state.internalGetDb().prepare('UPDATE local_sessions SET secure = 2').run()).toThrow(/CHECK/);
  });
});
