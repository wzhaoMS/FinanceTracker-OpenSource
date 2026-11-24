import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from './authRepo.js';
import { LocalAuthRepo } from './localAuthRepo.js';
import { SqliteStateRepo } from './sqliteStateRepo.js';

const repos: SqliteStateRepo[] = [];
afterEach(() => { for (const repo of repos.splice(0)) repo.close(); });

describe('durable local credential epochs at authorization effects', () => {
  it('changes across a reset at the same timestamp even if a caller deliberately preserves sessions', () => {
    const repo = new SqliteStateRepo({ file: ':memory:' });
    repos.push(repo);
    const users = new LocalAuthRepo(repo);
    const now = new Date('2026-10-18T00:00:00.000Z');
    const user = users.createUser('synthetic', 'synthetic-verifier-before', now);
    const session = users.createSession(user.id, 60_000, now, true);
    const id = hashToken(session.token);
    const before = users.sessionCredentialEpoch(id, user.id, now, true);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    users.setPasswordHash(user.username, 'synthetic-verifier-after', { revokeSessions: false }, now);
    expect(users.sessionCredentialEpoch(id, user.id, now, true)).not.toBe(before);
    expect(users.findSession(session.token, now)).not.toBeNull();
    expect(users.listUsers(now)[0]).not.toHaveProperty('credentialEpoch');
  });

  it('requires the original live session, user and secure profile, without writing during validation', () => {
    const repo = new SqliteStateRepo({ file: ':memory:' });
    repos.push(repo);
    const users = new LocalAuthRepo(repo);
    const now = new Date('2026-10-18T00:00:00.000Z');
    const user = users.createUser('synthetic', 'synthetic-verifier', now);
    const other = users.createUser('other', 'synthetic-other-verifier', now);
    const session = users.createSession(user.id, 1000, now, false);
    const id = hashToken(session.token);
    expect(users.sessionCredentialEpoch(id, user.id, now, true)).toBeNull();
    expect(users.sessionCredentialEpoch(id, other.id, now, false)).toBeNull();
    expect(users.sessionCredentialEpoch(id, user.id, new Date(now.getTime() + 1000), false)).toBeNull();
    expect(repo.internalGetDb().prepare('SELECT count(*) FROM local_sessions').pluck().get()).toBe(1);
    users.removeUser(user.username, user.id);
    expect(users.sessionCredentialEpoch(id, user.id, now, false)).toBeNull();
  });

  it('does not reset or remove a replacement user who reused the selected username', () => {
    const repo = new SqliteStateRepo({ file: ':memory:' });
    repos.push(repo);
    const users = new LocalAuthRepo(repo);
    const old = users.createUser('synthetic', 'old-verifier');
    users.removeUser(old.username);
    const replacement = users.createUser(old.username, 'replacement-verifier');
    expect(users.setPasswordHash(old.username, 'must-not-write', { revokeSessions: true, expectedUserId: old.id })).toBeNull();
    expect(users.removeUser(old.username, old.id)).toBe(false);
    expect(users.findUser(old.username)).toMatchObject({ id: replacement.id, passwordHash: 'replacement-verifier' });
  });
});
