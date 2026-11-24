import { describe, expect, it } from 'vitest';

import { DEFAULT_IP_POLICY, DEFAULT_USER_POLICY, LoginThrottle, type ThrottlePolicy } from './loginThrottle.js';

const POLICY: ThrottlePolicy = { freeFailures: 3, baseDelayMs: 1_000, maxDelayMs: 8_000, forgetAfterMs: 60_000 };
const keys = (ip: string, username: string) => ({ ip, username });

function throttle(overrides: Partial<{ ip: ThrottlePolicy; user: ThrottlePolicy; maxEntries: number }> = {}) {
  return new LoginThrottle({
    ipPolicy: overrides.ip ?? { ...POLICY, freeFailures: 100 },
    userPolicy: overrides.user ?? POLICY,
    maxEntries: overrides.maxEntries,
  });
}

describe('LoginThrottle', () => {
  it('uses 5 free attempts per username and 10 per IP by default, backing off up to 15 minutes', () => {
    expect(DEFAULT_USER_POLICY).toMatchObject({ freeFailures: 5, maxDelayMs: 15 * 60_000 });
    expect(DEFAULT_IP_POLICY).toMatchObject({ freeFailures: 10, maxDelayMs: 15 * 60_000 });
  });

  it('allows the free attempts, then locks with doubling delays up to the cap', () => {
    const t = throttle();
    let now = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) expect(t.begin(keys('1.1.1.1', 'alex'), now).allowed).toBe(true);
    expect(t.begin(keys('1.1.1.1', 'alex'), now)).toEqual({ allowed: false, retryAfterMs: 1_000 });
    const waits: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      const blocked = t.begin(keys('1.1.1.1', 'alex'), now);
      expect(blocked.allowed).toBe(false);
      now += (blocked as { retryAfterMs: number }).retryAfterMs;
      expect(t.begin(keys('1.1.1.1', 'alex'), now).allowed).toBe(true);
      waits.push((t.begin(keys('1.1.1.1', 'alex'), now) as { retryAfterMs: number }).retryAfterMs);
    }
    expect(waits).toEqual([2_000, 4_000, 8_000, 8_000, 8_000, 8_000]);
  });

  it('does not extend the lock for attempts refused while locked', () => {
    const t = throttle();
    for (let attempt = 0; attempt < 3; attempt += 1) t.begin(keys('1.1.1.1', 'alex'), 0);
    for (let refused = 0; refused < 20; refused += 1) expect(t.begin(keys('1.1.1.1', 'alex'), 500).allowed).toBe(false);
    expect(t.failures('user', 'alex')).toBe(3);
    expect(t.begin(keys('1.1.1.1', 'alex'), 1_000).allowed).toBe(true);
  });

  it('a successful sign-in clears both the username and the IP history', () => {
    const t = throttle({ ip: POLICY });
    t.begin(keys('1.1.1.1', 'alex'), 0);
    t.begin(keys('1.1.1.1', 'alex'), 0);
    t.succeed(keys('1.1.1.1', 'alex'));
    expect(t.failures('user', 'alex')).toBe(0);
    expect(t.failures('ip', '1.1.1.1')).toBe(0);
    for (let attempt = 0; attempt < 3; attempt += 1) expect(t.begin(keys('1.1.1.1', 'alex'), 0).allowed).toBe(true);
  });

  it('locks a username guessed from many addresses', () => {
    const t = throttle();
    for (let index = 0; index < 3; index += 1) t.begin(keys(`10.0.0.${index}`, 'alex'), 0);
    expect(t.begin(keys('10.0.0.99', 'alex'), 0).allowed).toBe(false);
    expect(t.begin(keys('10.0.0.99', 'casey'), 0).allowed).toBe(true);
  });

  it('locks an address that sprays many usernames', () => {
    const t = throttle({ ip: POLICY, user: { ...POLICY, freeFailures: 100 } });
    for (let index = 0; index < 3; index += 1) t.begin(keys('10.0.0.7', `user${index}`), 0);
    expect(t.begin(keys('10.0.0.7', 'alex'), 0).allowed).toBe(false);
    expect(t.begin(keys('10.0.0.8', 'alex'), 0).allowed).toBe(true);
  });

  it('counts attempts before the password check, so a concurrent burst cannot bypass the limit', () => {
    const t = throttle();
    const burst = Array.from({ length: 50 }, () => t.begin(keys('1.1.1.1', 'alex'), 0));
    expect(burst.filter((decision) => decision.allowed)).toHaveLength(3);
  });

  it('forgets failures after a quiet period', () => {
    const t = throttle();
    t.begin(keys('1.1.1.1', 'alex'), 0);
    t.begin(keys('1.1.1.1', 'alex'), 0);
    expect(t.failures('user', 'alex')).toBe(2);
    t.begin(keys('1.1.1.1', 'alex'), 60_001);
    expect(t.failures('user', 'alex')).toBe(1);
  });

  it('bounds memory by evicting the least recently used keys', () => {
    const t = throttle({ maxEntries: 10 });
    for (let index = 0; index < 100; index += 1) t.begin(keys('1.1.1.1', `user${index}`), index);
    expect(t.size).toBeLessThanOrEqual(10);
    expect(t.failures('ip', '1.1.1.1')).toBe(100);
  });
});
