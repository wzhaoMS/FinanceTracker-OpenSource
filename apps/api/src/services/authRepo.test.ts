import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SqliteStateRepo } from './sqliteStateRepo.js';
import { AuthRepo, hashToken } from './authRepo.js';

let dir: string;
let state: SqliteStateRepo;
let auth: AuthRepo;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-auth-'));
  state = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  auth = new AuthRepo(state);
});

afterEach(async () => {
  state.close();
  await rm(dir, { recursive: true, force: true });
});

describe('AuthRepo households + users', () => {
  it('starts with zero users and zero households', () => {
    expect(auth.hasAnyUser()).toBe(false);
    expect(auth.getSingleHousehold()).toBeNull();
  });

  it('creates a household and looks it up by id', () => {
    const hh = auth.createHousehold("Alex's household");
    expect(hh.id).toMatch(/^hh_/);
    expect(hh.name).toBe("Alex's household");
    expect(auth.getSingleHousehold()?.id).toBe(hh.id);
    expect(auth.getHousehold(hh.id)?.id).toBe(hh.id);
  });

  it('refuses to create a second household (single-household invariant)', () => {
    auth.createHousehold('first');
    expect(() => auth.createHousehold('second')).toThrow(/single-household/);
  });

  it('creates a user with membership in one transaction', () => {
    const hh = auth.createHousehold('H');
    const u = auth.createUserWithMembership({
      householdId: hh.id,
      email: 'alex@example.com',
      name: 'Alex',
      googleSub: 'sub-alex',
      role: 'owner',
    });
    expect(u.id).toMatch(/^u_/);
    expect(u.householdId).toBe(hh.id);
    expect(auth.hasAnyUser()).toBe(true);
    const members = auth.listMembers(hh.id);
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe('owner');
    expect(members[0].email).toBe('alex@example.com');
  });

  it('rejects a duplicate googleSub via unique constraint', () => {
    const hh = auth.createHousehold('H');
    auth.createUserWithMembership({
      householdId: hh.id, email: 'user2@example.com', name: 'A', googleSub: 'dup', role: 'owner',
    });
    expect(() =>
      auth.createUserWithMembership({
        householdId: hh.id, email: 'user3@example.com', name: 'B', googleSub: 'dup', role: 'member',
      }),
    ).toThrow(/UNIQUE/);
  });

  it('finds a user by googleSub', () => {
    const hh = auth.createHousehold('H');
    const u = auth.createUserWithMembership({
      householdId: hh.id, email: 'user2@example.com', name: 'A', googleSub: 'g-1', role: 'owner',
    });
    expect(auth.getUserByGoogleSub('g-1')?.id).toBe(u.id);
    expect(auth.getUserByGoogleSub('missing')).toBeNull();
  });
});

describe('AuthRepo sessions', () => {
  it('issues a session and finds it by raw cookie value', () => {
    const hh = auth.createHousehold('H');
    const u = auth.createUserWithMembership({
      householdId: hh.id, email: 'user2@example.com', name: 'A', googleSub: 'g', role: 'owner',
    });
    const { secret } = auth.createSession(u.id);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const found = auth.findActiveSession(secret);
    expect(found?.userId).toBe(u.id);
  });

  it('stores only sha256(secret), never the raw secret', () => {
    const hh = auth.createHousehold('H');
    const u = auth.createUserWithMembership({
      householdId: hh.id, email: 'user2@example.com', name: 'A', googleSub: 'g', role: 'owner',
    });
    const { secret } = auth.createSession(u.id);
    const internal = state as unknown as { db: { prepare(sql: string): { all(): unknown[] } } };
    const rows = internal.db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    // Stored ID must equal sha256(secret), not the secret itself.
    expect(rows[0].id).toBe(hashToken(secret));
    expect(rows[0].id).not.toBe(secret);
  });

  it('rejects an unknown cookie value', () => {
    expect(auth.findActiveSession('does-not-exist')).toBeNull();
  });

  it('expires sessions past their TTL and self-cleans on lookup', () => {
    const hh = auth.createHousehold('H');
    const u = auth.createUserWithMembership({
      householdId: hh.id, email: 'user2@example.com', name: 'A', googleSub: 'g', role: 'owner',
    });
    const { secret } = auth.createSession(u.id, 0); // already expired
    expect(auth.findActiveSession(secret)).toBeNull();
    // Row was reaped.
    const internal = state as unknown as { db: { prepare(sql: string): { all(): unknown[] } } };
    const rows = internal.db.prepare('SELECT id FROM sessions').all();
    expect(rows).toHaveLength(0);
  });

  it('deleteSession removes the active session', () => {
    const hh = auth.createHousehold('H');
    const u = auth.createUserWithMembership({
      householdId: hh.id, email: 'user2@example.com', name: 'A', googleSub: 'g', role: 'owner',
    });
    const { secret } = auth.createSession(u.id);
    expect(auth.deleteSession(secret)).toBe(true);
    expect(auth.findActiveSession(secret)).toBeNull();
    expect(auth.deleteSession(secret)).toBe(false); // already gone
  });
});

describe('AuthRepo OAuth state (CSRF binding)', () => {
  it('round-trips state with the matching csrf', () => {
    const csrf = 'csrf-secret-1234';
    const state = auth.createOAuthState({ csrfSecret: csrf });
    const consumed = auth.consumeOAuthState(state, csrf);
    expect(consumed).not.toBeNull();
    expect(consumed!.inviteTokenHash).toBeNull();
  });

  it('rejects mismatched csrf and burns the state row anyway', () => {
    const state = auth.createOAuthState({ csrfSecret: 'right' });
    const consumed = auth.consumeOAuthState(state, 'wrong');
    expect(consumed).toBeNull();
    // Single-use: even on mismatch the row is deleted (defense against replay).
    const second = auth.consumeOAuthState(state, 'right');
    expect(second).toBeNull();
  });

  it('binds an invite token; returned hash matches', () => {
    const csrf = 'csrf';
    const invite = 'invite-secret';
    const state = auth.createOAuthState({ csrfSecret: csrf, inviteToken: invite });
    const consumed = auth.consumeOAuthState(state, csrf);
    expect(consumed!.inviteTokenHash).toBe(hashToken(invite));
  });

  it('treats expired state rows as missing', () => {
    const state = auth.createOAuthState({ csrfSecret: 'csrf', ttlMs: -1_000 });
    expect(auth.consumeOAuthState(state, 'csrf')).toBeNull();
  });

  it('reapOAuthState removes expired rows in bulk', () => {
    auth.createOAuthState({ csrfSecret: 'a', ttlMs: -1_000 });
    auth.createOAuthState({ csrfSecret: 'b', ttlMs: -1_000 });
    auth.createOAuthState({ csrfSecret: 'c', ttlMs: 60_000 });
    expect(auth.reapOAuthState()).toBe(2);
  });
});
