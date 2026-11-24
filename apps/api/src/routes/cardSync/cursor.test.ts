import { describe, expect, it } from 'vitest';

import { CARD_SYNC_CURSOR_MAX_LENGTH, CardSyncCursorCodec, type CardSyncCursorKind, type CardSyncCursorValues } from './cursor.js';

// E1b design §10 items 17 and 20 (Revision 7; test 202): the owner API's cursor codec.

const SECRET = 'c3'.repeat(32);
const codec = new CardSyncCursorCodec(SECRET);
const letters = (seed: string) => seed.repeat(32).slice(0, 32);

const SAMPLES: { [K in CardSyncCursorKind]: CardSyncCursorValues[K][] } = {
  items: [
    { version: 1, ledgerRevision: 0, pastDeadline: false, itemKey: -1 },
    { version: 2_147_483_647, ledgerRevision: 2_147_483_647, pastDeadline: true, itemKey: 1_999 },
  ],
  effects: [{ afterOrdinal: -1 }, { afterOrdinal: 0 }, { afterOrdinal: 9_999 }],
  events: [{ createdAt: '2026-10-17T10:00:00.000Z', eventId: `card-event-${letters('ap')}` },
    { createdAt: '1970-01-01T00:00:00.000Z', eventId: `card-event-${letters('p')}` }],
  identities: [{ createdAt: '2099-12-31T23:59:59.999Z', identityId: `card-ident-${letters('bc')}` }],
  merged: [{ removedAt: '2026-01-02T03:04:05.006Z', transactionId: `card-txn-${letters('de')}` }],
  sets: [{ acceptedAt: '2026-10-17T10:00:00.000Z', setId: `obs_${letters('f')}` }],
  runs: [{ createdAt: '2026-10-17T10:00:00.000Z', runId: `run_${letters('g')}` }],
  authority: [{ afterRowId: 1 }, { afterRowId: 2_147_483_647 }],
};

describe('the owner API cursor codec', () => {
  it('round-trips every kind within 1–64 letters a–p, bound to its resource', () => {
    expect(CARD_SYNC_CURSOR_MAX_LENGTH).toBeLessThanOrEqual(64);
    for (const kind of Object.keys(SAMPLES) as CardSyncCursorKind[]) {
      for (const values of SAMPLES[kind]) {
        const cursor = codec.encode(kind, 'resource-1', values as never);
        expect(cursor).toMatch(/^[a-p]{1,64}$/);
        expect(codec.decode(kind, 'resource-1', cursor)).toEqual(values);
        // Another resource or kind, or a fresh codec under another secret, refuses it; the same secret after a restart takes it.
        expect(codec.decode(kind, 'resource-2', cursor)).toBeNull();
        expect(new CardSyncCursorCodec('d4'.repeat(32)).decode(kind, 'resource-1', cursor)).toBeNull();
        expect(new CardSyncCursorCodec(SECRET).decode(kind, 'resource-1', cursor)).toEqual(values);
        for (const other of Object.keys(SAMPLES) as CardSyncCursorKind[]) {
          if (other !== kind) expect(codec.decode(other, 'resource-1', cursor)).toBeNull();
        }
      }
    }
  });

  it('refuses every altered letter, every other length and anything that is not a–p letters', () => {
    const cursor = codec.encode('items', 'set', { version: 3, ledgerRevision: 9, pastDeadline: false, itemKey: 99 });
    for (let i = 0; i < cursor.length; i += 1) {
      const altered = cursor.slice(0, i) + (cursor[i] === 'a' ? 'b' : 'a') + cursor.slice(i + 1);
      expect(codec.decode('items', 'set', altered)).toBeNull();
    }
    for (const bad of ['', cursor.slice(1), `${cursor}a`, cursor.toUpperCase(), `${cursor.slice(0, -1)}1`, `${cursor.slice(0, -1)}q`, 42, null,
      undefined, [cursor], { cursor }]) {
      expect(codec.decode('items', 'set', bad)).toBeNull();
    }
  });

  it('refuses decoded fields out of range even under a valid tag, and encodes nothing outside its fields', () => {
    for (const values of [
      { version: 0, ledgerRevision: 0, pastDeadline: false, itemKey: 0 },
      { version: 1, ledgerRevision: -1, pastDeadline: false, itemKey: 0 },
      { version: 1, ledgerRevision: 0, pastDeadline: false, itemKey: 2_000 },
      { version: 1, ledgerRevision: 0, pastDeadline: false, itemKey: -2 },
      { version: 1.5, ledgerRevision: 0, pastDeadline: false, itemKey: 0 },
      { version: 1, ledgerRevision: 0, pastDeadline: 'no', itemKey: 0 },
    ]) {
      expect(() => codec.encode('items', 'set', values as never)).toThrow(RangeError);
    }
    expect(() => codec.encode('effects', 'plan', { afterOrdinal: 10_000 })).toThrow(RangeError);
    expect(() => codec.encode('events', 'txn', { createdAt: '2026-10-17T10:00:00Z', eventId: `card-event-${letters('a')}` })).toThrow(RangeError);
    expect(() => codec.encode('events', 'txn', { createdAt: '2026-02-30T10:00:00.000Z', eventId: `card-event-${letters('a')}` })).toThrow(RangeError);
    expect(() => codec.encode('sets', 'open', { acceptedAt: '2026-10-17T10:00:00.000Z', setId: `run_${letters('a')}` })).toThrow(RangeError);
    expect(() => new CardSyncCursorCodec('short')).toThrow(TypeError);
  });

  it('never carries a digit, so no cursor can look like card data', () => {
    for (let i = 0; i < 200; i += 1) {
      const cursor = codec.encode('effects', `plan-${i}`, { afterOrdinal: i * 37 });
      expect(cursor).not.toMatch(/\d/);
    }
  });
});
