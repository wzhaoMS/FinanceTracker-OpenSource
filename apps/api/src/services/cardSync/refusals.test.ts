import { describe, expect, it } from 'vitest';

import { HoldrDbError, HoldrGuardRefusal, HoldrRefusal } from '../dbErrors.js';
import { CARD_SYNC_REFUSAL_CODES, CARD_SYNC_REFUSALS, cardSyncRefusal, cardSyncRefusalCode } from './refusals.js';

// E1b design §5.0, §5.11: every card-sync refusal is an untouched
// HoldrRefusal with a fixed `card-sync:<code>` message; the code is all E2
// maps (E2 in §7.6).

describe('card-sync refusals', () => {
  it('lists each §5.11 code once, as constants the boundary can pass on', () => {
    expect(new Set(CARD_SYNC_REFUSAL_CODES).size).toBe(CARD_SYNC_REFUSAL_CODES.length);
    for (const code of CARD_SYNC_REFUSAL_CODES) {
      expect(code).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(CARD_SYNC_REFUSALS.has(`card-sync:${code}`)).toBe(true);
    }
    expect(CARD_SYNC_REFUSALS.size).toBe(CARD_SYNC_REFUSAL_CODES.length);
  });

  it('makes untouched, frozen HoldrRefusals and reads their code back', () => {
    for (const code of CARD_SYNC_REFUSAL_CODES) {
      const refusal = cardSyncRefusal(code);
      expect(Object.getPrototypeOf(refusal)).toBe(HoldrRefusal.prototype);
      expect(refusal.message).toBe(`card-sync:${code}`);
      expect(Object.isFrozen(refusal)).toBe(true);
      expect(cardSyncRefusalCode(refusal)).toBe(code);
    }
  });

  it('reads no code from anything else', () => {
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('trap'); } });
    for (const other of [
      new HoldrRefusal('card account does not exist'), new HoldrRefusal('card-sync:not-a-code'), new Error('card-sync:version-conflict'),
      new HoldrDbError('read card sync settings', 'SQLITE_BUSY'), new HoldrGuardRefusal('card_scopes.label must not contain a card number'),
      'card-sync:version-conflict', null, undefined, hostile,
    ]) {
      expect(cardSyncRefusalCode(other)).toBeUndefined();
    }
  });
});
