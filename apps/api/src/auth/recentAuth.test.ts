import { describe, expect, it } from 'vitest';

import { RecentAuth, RECENT_AUTH_MS } from './recentAuth.js';

describe('recent authentication (E1b design §10 items 11 and 14)', () => {
  it('lasts five minutes for the session that confirmed, and for no other', () => {
    const recent = new RecentAuth();
    expect(recent.confirm('session-a', 1_000)).toBe(1_000 + RECENT_AUTH_MS);
    expect(recent.isRecent('session-a', 1_000 + RECENT_AUTH_MS - 1)).toBe(true);
    expect(recent.isRecent('session-b', 1_000)).toBe(false);
    expect(recent.isRecent('session-a', 1_000 + RECENT_AUTH_MS)).toBe(false);
    expect(recent.size).toBe(0);
  });

  it('ends at sign-out, renews on a new confirmation, and stays bounded', () => {
    const recent = new RecentAuth(60_000, 3);
    recent.confirm('a', 0);
    recent.confirm('a', 30_000);
    expect(recent.isRecent('a', 80_000)).toBe(true);
    recent.forget('a');
    expect(recent.isRecent('a', 80_000)).toBe(false);
    for (const id of ['b', 'c', 'd', 'e']) recent.confirm(id, 100_000);
    expect(recent.size).toBe(3);
    expect(recent.isRecent('b', 100_001)).toBe(false);
    expect(recent.isRecent('e', 100_001)).toBe(true);
    // Lapsed confirmations go first.
    recent.confirm('f', 200_000);
    expect(recent.size).toBe(1);
  });
});
