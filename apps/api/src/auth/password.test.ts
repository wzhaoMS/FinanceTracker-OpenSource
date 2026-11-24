import { describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import { timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_SCRYPT_PARAMS,
  MAX_PASSWORD_LENGTH,
  dummyPasswordHash,
  hashPassword,
  needsRehash,
  passwordProblem,
  verifyPassword,
} from './password.js';

const FAST = { ln: 10, r: 8, p: 1 };

describe('password hashing', () => {
  it('stores the scrypt parameters, a 16-byte salt and a 32-byte key, never the password', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    expect(hash).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(hash).not.toContain('correct');
  });

  it('defaults to OWASP-strength parameters (N=2^15, r=8, p=3)', async () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ ln: 15, r: 8, p: 3 });
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$scrypt$ln=15,r=8,p=3$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(needsRehash(hash)).toBe(false);
  });

  it('salts every hash separately', async () => {
    const first = await hashPassword('same password', FAST);
    const second = await hashPassword('same password', FAST);
    expect(first).not.toBe(second);
    expect(first.split('$')[3]).not.toBe(second.split('$')[3]);
    expect(await verifyPassword('same password', first)).toBe(true);
    expect(await verifyPassword('same password', second)).toBe(true);
  });

  it('accepts only the exact password', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    for (const wrong of ['Correct horse battery', 'correct horse battery ', 'correct horse batter', '', 'x'.repeat(64)]) {
      expect(await verifyPassword(wrong, hash), wrong).toBe(false);
    }
  });

  it('compares derived keys with timingSafeEqual', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    vi.mocked(timingSafeEqual).mockClear();
    await verifyPassword('wrong password', hash);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it('verifies with the parameters stored in the hash and flags weaker ones for rehash', async () => {
    const weak = await hashPassword('correct horse battery', FAST);
    expect(await verifyPassword('correct horse battery', weak)).toBe(true);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(weak, FAST)).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });

  it('treats composed and decomposed accents as the same password', async () => {
    const hash = await hashPassword('café au lait', FAST);
    expect(await verifyPassword('cafe\u0301 au lait', hash)).toBe(true);
  });

  it('returns false for malformed, foreign or out-of-range hashes instead of throwing', async () => {
    const good = await hashPassword('correct horse battery', FAST);
    const [, , , salt, key] = good.split('$');
    for (const stored of [
      '',
      'correct horse battery',
      `$argon2id$v=19$m=65536,t=3,p=4$${salt}$${key}`,
      `$scrypt$ln=30,r=8,p=1$${salt}$${key}`,
      `$scrypt$ln=10,r=99,p=1$${salt}$${key}`,
      `$scrypt$ln=10,r=8,p=1$${salt}`,
      `$scrypt$ln=10,r=8,p=1$c2hvcnQ$${key}`,
    ]) {
      await expect(verifyPassword('correct horse battery', stored), stored).resolves.toBe(false);
    }
  });

  it('refuses over-long input without running scrypt', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    expect(await verifyPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1), hash)).toBe(false);
  });

  it('keeps one real dummy hash per parameter set for unknown-user logins', async () => {
    const first = await dummyPasswordHash(FAST);
    expect(await dummyPasswordHash(FAST)).toBe(first);
    expect(first.startsWith('$scrypt$ln=10,r=8,p=1$')).toBe(true);
    expect(await verifyPassword('anything at all', first)).toBe(false);
  });
});

describe('password policy', () => {
  it('requires 8 to 1024 characters and not the username', () => {
    expect(passwordProblem('seven77')).toMatch(/at least 8/);
    expect(passwordProblem('eight888')).toBeNull();
    expect(passwordProblem('ü'.repeat(8))).toBeNull();
    expect(passwordProblem('a'.repeat(MAX_PASSWORD_LENGTH + 1))).toMatch(/at most/);
    expect(passwordProblem('casey123', 'casey123')).toMatch(/username/);
    expect(passwordProblem('Casey123', 'casey123')).toMatch(/username/);
  });
});
