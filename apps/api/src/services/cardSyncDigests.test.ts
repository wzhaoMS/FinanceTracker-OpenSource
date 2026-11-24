import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { cardSyncPayloadDigest, type JsonValue } from '@finance-tracker/shared';

import { CardSyncScenario } from '../testing/cardSyncScenario.js';
import {
  CARD_SYNC_ROW_ID_PREFIXES,
  captureFingerprintIdentity,
  cardSyncPayloadDigestNative,
  cardSyncActorRef,
  cardSyncHash,
  cashEventRef,
  deviceFingerprint,
  deviceTokenDigest,
  newCardSyncId,
  newCardSyncRowId,
  pairingCodeDigest,
  randomCardSyncLetters,
  rowContentDigest,
  type CardRowContent,
} from './cardSyncDigests.js';

// Design §2.0.3: H(parts) = toLetterHex(sha256(utf8(JSON.stringify(parts)))),
// implemented once, with golden vectors. The vectors below were computed
// once and pinned; `independentH` restates the definition (as the design's
// validator writes it) so each vector is also checked against the formula.

const independentH = (parts: readonly unknown[]) => Array.from(
  createHash('sha256').update(Buffer.from(JSON.stringify(parts), 'utf8')).digest(),
  (byte) => 'abcdefghijklmnop'[byte >> 4] + 'abcdefghijklmnop'[byte & 15],
).join('');

const POSTED: CardRowContent = {
  transactionDate: '2026-10-01', postedDate: '2026-10-02', status: 'posted', amountMinor: 1234, kind: 'purchase',
  description: 'SYNTHETIC COFFEE', merchant: null, issuerCategory: null, originalAmountMinor: null, originalCurrency: null,
};
const PENDING_FOREIGN: CardRowContent = {
  ...POSTED, postedDate: null, status: 'pending', merchant: 'Café Ünicode', issuerCategory: 'Dining', originalAmountMinor: 1100,
  originalCurrency: 'EUR',
};

describe('card-sync digests: golden vectors', () => {
  it.each<[string, () => string, string]>([
    ['H', () => cardSyncHash(['holdr.test', 1, 'a']),
      'ohfpmdgnbbipoenbjnkpobjkbnpbokcglbbijjbginoaajnofjdhdjnhoigehgdk'],
    ['usr_ actor reference', () => cardSyncActorRef('local-user-1'), 'usr_mhciadlggnapghjodbjbbcjpnhdodmaj'],
    ['rcd1: content of a posted row', () => rowContentDigest(POSTED),
      'rcd1:dddfcbfhpafeepakjcgoafeljmckjnpfbmppecmgebikbeipdljbjlfgnplbodbd'],
    ['rcd1: content of a pending foreign-currency row', () => rowContentDigest(PENDING_FOREIGN),
      'rcd1:jlcmpblaebmnhholfdhikmjkcodbkjhaneicegaijbpobmjhombloiajigcncfpd'],
    ['ccf1: capture identity', () => captureFingerprintIdentity(`cpt_${'a'.repeat(32)}`, `cfp1:${'b'.repeat(64)}`),
      'ccf1:jflfakfadbeemeipmmmnlghpfbnomcakpeeenojokgkfdoaabkfdpcokdjgmgflh'],
    ['hdh1: device token digest', () => deviceTokenDigest('token-1'),
      'hdh1:niolcnpoocideklcmpaboehhnpncibggdifdmlnfafdnidomgfiolbnalljpoaon'],
    ['hph1: pairing code digest', () => pairingCodeDigest('ABCD-EFGH'),
      'hph1:bdkioagbmffehnndohckfjlmbmefeihahcpjbgofmgggjmmjepdjmaghgpbobigk'],
    ['cer1: cash event reference', () => cashEventRef('cash-event-1'),
      'cer1:nhhcngjendcojmjfjhcjmlagplfedmdikaknlmllmgbehimecbonbflepoogibnl'],
    ['device fingerprint', () => deviceFingerprint('token-1'), 'maakijnkadimgjoo'],
  ])('%s', (_label, compute, expected) => {
    expect(compute()).toBe(expected);
  });

  it('computes each vector by the design\'s definition, with purpose and version first', () => {
    expect(cardSyncHash(['holdr.test', 1, 'a'])).toBe(independentH(['holdr.test', 1, 'a']));
    expect(cardSyncActorRef('local-user-1')).toBe(`usr_${independentH(['holdr.card-sync-actor', 1, 'local-user-1']).slice(0, 32)}`);
    // The validator's rcd1, field for field (validate-ddl.mjs).
    expect(rowContentDigest(PENDING_FOREIGN)).toBe(`rcd1:${independentH(['holdr.card-row-content', 1, '2026-10-01', null, 'pending', 1234,
      'purchase', 'SYNTHETIC COFFEE', 'Café Ünicode', 'Dining', 1100, 'EUR'])}`);
    expect(captureFingerprintIdentity('cpt_x', 'cfp1:y')).toBe(`ccf1:${independentH(['holdr.card-capture-fingerprint', 1, 'cpt_x', 'cfp1:y'])}`);
    expect(deviceTokenDigest('t')).toBe(`hdh1:${independentH(['holdr.card-sync-device-token', 1, 't'])}`);
    expect(pairingCodeDigest('c')).toBe(`hph1:${independentH(['holdr.card-sync-pairing-code', 1, 'c'])}`);
    expect(cashEventRef('e')).toBe(`cer1:${independentH(['holdr.cash-event-ref', 1, 'e'])}`);
    expect(deviceFingerprint('t')).toBe(independentH(['holdr.card-sync-device-fingerprint', 1, 't']).slice(0, 16));
  });

  it('keeps field boundaries: no two contents that differ only in where a field ends share a digest', () => {
    expect(rowContentDigest({ ...POSTED, description: 'A B', merchant: null }))
      .not.toBe(rowContentDigest({ ...POSTED, description: 'A', merchant: 'B' }));
    expect(rowContentDigest({ ...POSTED, merchant: null })).not.toBe(rowContentDigest({ ...POSTED, merchant: '' }));
    expect(deviceTokenDigest('x')).not.toBe(pairingCodeDigest('x').replace('hph1:', 'hdh1:'));
  });
});

describe('card-sync digests: the letters-only grammar (no digit run can be stored)', () => {
  it('issues ids and digests in letters a–p only, after their fixed prefixes', () => {
    for (const prefix of CARD_SYNC_ROW_ID_PREFIXES) expect(newCardSyncRowId(prefix)).toMatch(new RegExp(`^${prefix}[a-p]{32}$`));
    for (const prefix of ['scp_', 'bnd_', 'run_', 'obs_', 'prv_', 'dev_', 'pai_', 'rvw_', 'agn_'] as const) {
      expect(newCardSyncId(prefix)).toMatch(new RegExp(`^${prefix}[a-p]{32}$`));
    }
    expect(randomCardSyncLetters()).toMatch(/^[a-p]{32}$/);
    expect(new Set(Array.from({ length: 100 }, () => randomCardSyncLetters())).size).toBe(100);
    for (const digest of [rowContentDigest(POSTED), deviceTokenDigest('t'), pairingCodeDigest('c'), cashEventRef('e'),
      captureFingerprintIdentity('cpt_x', 'cfp1:y')]) {
      expect(digest).toMatch(/^[a-z]{3}1:[a-p]{64}$/);
    }
  });

  it('refuses an actor without a local user id', () => {
    expect(() => cardSyncActorRef('')).toThrow(TypeError);
    expect(() => cardSyncActorRef(undefined as never)).toThrow(TypeError);
  });
});

describe('cardSyncPayloadDigestNative', () => {
  // A seeded generator of JSON values: nested objects and arrays, integers, fractions and text from every UTF-8 length,
  // escapes and astral characters included.
  function values(seed: number): JsonValue[] {
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 4_294_967_296;
    };
    const ALPHABET = ['a', 'Z', '0', ' ', '"', '\\', '\n', '\u0001', '\u007f', 'é', 'ß', '€', '中', '😀', '\u2028', '\ufeff'];
    const text = () => Array.from({ length: Math.floor(next() * 12) }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join('');
    const value = (depth: number): JsonValue => {
      const pick = Math.floor(next() * (depth > 3 ? 5 : 7));
      if (pick === 0) return null;
      if (pick === 1) return next() < 0.5;
      if (pick === 2) return Math.floor((next() - 0.5) * 2 ** 40);
      if (pick === 3) return Math.round((next() - 0.5) * 1e6) / 1000;
      if (pick === 4) return text();
      if (pick === 5) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(next() * 4) }, () => [text(), value(depth + 1)]));
    };
    return Array.from({ length: 300 }, () => value(0));
  }

  it('is shared\'s cardSyncPayloadDigest for random JSON values', () => {
    for (const value of values(20261018)) expect(cardSyncPayloadDigestNative(value)).toBe(cardSyncPayloadDigest(value));
  });

  it('is shared\'s for a whole v2 payload, and refuses what shared\'s refuses', () => {
    const w = new CardSyncScenario();
    try {
      w.enable('chase');
      const binding = w.binding();
      const { known } = w.scopes(binding);
      const payload = w.payload(binding, [{ scope: known[0], date: '2026-10-01', amount: 1250, description: 'CAFÉ ZÜRICH 😀', id: 'sor-1' },
        { scope: known[1], date: '2026-10-02', status: 'pending', amount: -500, kind: 'refund',
        description: 'NORTHWIND REFUND' }]);
      expect(cardSyncPayloadDigestNative(payload)).toBe(cardSyncPayloadDigest(payload));
    } finally {
      w.close();
    }
    for (const bad of [{ text: '\ud800' }, { number: Number.NaN }, { number: -0 }]) {
      expect(() => cardSyncPayloadDigest(bad)).toThrow();
      expect(() => cardSyncPayloadDigestNative(bad)).toThrow();
    }
  });
});
