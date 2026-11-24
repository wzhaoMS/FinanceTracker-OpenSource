import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cardNicknameKey, cardSchedulePayloadDigest, validateCardScheduleObservation, type ValidCardScheduleObservation } from './observations.js';

/** Strict validation, the mixed-row rule and the M contract (spec v9 §2–§3). Synthetic values only. */

const REF = `sha256:${'c'.repeat(64)}`;
const pdf = (extra: Record<string, unknown> = {}) => ({
  card: { issuer: 'testbank', last4: '1234' },
  currency: 'USD',
  sourceKind: 'statement-pdf',
  sourceRef: REF,
  observedAt: '2026-10-05T12:00:00Z',
  extractorVersion: 'testbank-statement@1',
  asOf: { source: 'statement', at: '2026-10-02', precision: 'date' },
  statementClosingDate: '2026-10-02',
  paymentDueDate: '2026-10-27',
  statementBalanceMinor: 5000,
  minimum: { minor: 2500, basis: 'total-due' },
  pastDueMinor: 0,
  ...extra,
});
const dom = (extra: Record<string, unknown> = {}) => ({
  card: { issuer: 'testbank', last5: '51234' },
  currency: 'USD',
  sourceKind: 'issuer-dashboard-dom',
  sourceRef: REF,
  observedAt: '2026-10-20T16:00:00.000Z',
  extractorVersion: 'testbank-overview@1',
  paymentDueDate: '2026-10-27',
  ...extra,
});

function valid(input: unknown): ValidCardScheduleObservation {
  const result = validateCardScheduleObservation(input);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.value;
}
function refused(input: unknown): string {
  const result = validateCardScheduleObservation(input);
  assert.equal(result.ok, false);
  return (result as { reason: string }).reason;
}

describe('validateCardScheduleObservation', () => {
  it('a statement PDF row: every field effective at its close', () => {
    const value = valid(pdf());
    assert.equal(value.financialAsOf, '2026-10-02');
    assert.equal(value.asOfSource, 'statement');
    assert.equal(value.asOfPrecision, 'date');
    assert.equal(value.minimumDueMinor, 2500);
    assert.equal(value.minimumBasis, 'total-due');
    assert.equal(value.heldReason, null);
    assert.equal(value.observedAt, '2026-10-05T12:00:00.000Z');
  });

  it('mixed rows: a PDF with an explicit current as-of, a statement as-of without C, a missing as-of, and a statement as-of on a dashboard row are refused', () => {
    assert.equal(refused(pdf({ asOf: { source: 'explicit', at: '2026-10-04T12:00:00Z', precision: 'instant' } })), 'asOf');
    assert.equal(refused(pdf({ asOf: { source: 'statement', at: '2026-10-03', precision: 'date' } })), 'asOf');
    const { statementClosingDate: _c, ...noClose } = pdf();
    assert.equal(refused(noClose), 'statementClosingDate');
    const { asOf: _a, ...noAsOf } = pdf();
    assert.equal(refused(noAsOf), 'asOf');
    assert.equal(refused(dom({ asOf: { source: 'statement', at: '2026-10-02', precision: 'date' } })), 'asOf.source');
  });

  it('a dashboard row\'s live fields without an issuer-stated as-of are implicit-capture at the read; with one they are explicit', () => {
    const implicit = valid(dom({ remainingStatementMinor: 4000 }));
    assert.equal(implicit.asOfSource, 'implicit-capture');
    assert.equal(implicit.financialAsOf, '2026-10-20T16:00:00.000Z');
    const explicit = valid(dom({ asOf: { source: 'explicit', at: '2026-10-19', precision: 'date' }, statementClosingDate: '2026-10-02',
      statementBalanceMinor: 5000, minimum: { minor: 2500, basis: 'total-due' }, remainingStatementMinor: 4000, pastDueMinor: 0 }));
    assert.equal(explicit.asOfSource, 'explicit');
    assert.equal(explicit.financialAsOf, '2026-10-19');
    assert.equal(explicit.statementClosingDate, '2026-10-02');
  });

  it('the M contract: only a total-due minimum is stored; current-only, unknown or no basis holds the row and stores no M', () => {
    for (const minimum of [{ minor: 2500, basis: 'current-only' }, { minor: 2500, basis: 'unknown' }, { minor: 2500 }]) {
      const value = valid(pdf({ minimum }));
      assert.equal(value.heldReason, 'minimum-basis');
      assert.equal(value.minimumDueMinor, null);
      assert.equal(value.minimumBasis, null);
    }
    assert.equal(refused(pdf({ minimum: { minor: 2500, basis: 'current-plus-past-due' } })), 'minimum.basis');
    const { minimum: _m, ...noMinimum } = pdf();
    assert.equal(valid(noMinimum).minimumDueMinor, null);
  });

  it('neither a closing nor a due date: held cycle-unknown', () => {
    const { paymentDueDate: _d, ...noDates } = dom({ pastDueMinor: 0 });
    assert.equal(valid(noDates).heldReason, 'cycle-unknown');
  });

  it('exact keys: unknown keys, null values and missing required keys are refused', () => {
    assert.equal(refused(pdf({ note: 'x' })), 'unknown-key');
    assert.equal(refused(pdf({ pastDueMinor: null })), 'pastDueMinor');
    const { currency: _c, ...noCurrency } = pdf();
    assert.equal(refused(noCurrency), 'currency');
    assert.equal(refused(pdf({ card: { issuer: 'testbank', last4: '1234', number: '4111' } })), 'card');
    assert.equal(refused(pdf({ asOf: { source: 'statement', at: '2026-10-02', precision: 'date', extra: 1 } })), 'asOf');
  });

  it('per-field ranges', () => {
    assert.equal(refused(pdf({ pastDueMinor: -1 })), 'pastDueMinor');
    assert.equal(refused(pdf({ minimum: { minor: -1, basis: 'total-due' } })), 'minimum.minor');
    assert.equal(refused(pdf({ statementBalanceMinor: 1_000_000_000_000 })), 'statementBalanceMinor');
    assert.equal(refused(pdf({ statementBalanceMinor: 1.5 })), 'statementBalanceMinor');
    assert.equal(refused(pdf({ lastPaymentMinor: 0 })), 'lastPaymentMinor');
    assert.equal(refused(pdf({ scheduledPaymentMinor: -5 })), 'scheduledPaymentMinor');
    assert.equal(refused(pdf({ autopayFixedMinor: 5000, autopay: 'on-statement' })), 'autopayFixedMinor');
    assert.equal(valid(pdf({ autopayFixedMinor: 5000, autopay: 'on-fixed' })).autopayFixedMinor, 5000);
    assert.equal(refused(pdf({ autopay: 'sometimes' })), 'autopay');
    assert.equal(refused(pdf({ issuerPhrase: 'overdue' })), 'issuerPhrase');
    assert.equal(valid(pdf({ statementBalanceMinor: -300, remainingStatementMinor: -300 })).statementBalanceMinor, -300);
    assert.equal(refused(pdf({ paymentDueDate: '2026-09-30' })), 'paymentDueDate');
    assert.equal(refused(pdf({ statementPeriodStartDate: '2026-10-02' })), 'statementPeriodStartDate');
    assert.equal(refused(dom({ statementPeriodStartDate: '2026-09-03' })), 'statementPeriodStartDate');
    assert.equal(refused(pdf({ paymentDueDate: '2026-02-30' })), 'paymentDueDate');
    assert.equal(refused(pdf({ lastPaymentDate: '2026-10-03', lastPaymentMinor: 5000 })), 'lastPaymentDate');
    assert.equal(refused(dom({ asOf: { source: 'explicit', at: '2026-10-21T12:00:00Z', precision: 'instant' } })), 'asOf.at');
    assert.equal(refused(pdf({ observedAt: '2026-10-05T12:00:00+00:00' })), 'observedAt');
    assert.equal(refused(pdf({ extractorVersion: 'has space' })), 'extractorVersion');
  });

  it('card references and source references', () => {
    assert.equal(refused(pdf({ card: { issuer: 'testbank' } })), 'card.last4');
    assert.equal(refused(pdf({ card: { issuer: 'testbank', last4: '123' } })), 'card.last4');
    assert.equal(refused(pdf({ card: { issuer: 'testbank', last4: '1234', last5: '91235' } })), 'card.last5');
    assert.equal(refused(pdf({ card: { issuer: 'Test Bank', last4: '1234' } })), 'card.issuer');
    assert.equal(refused(pdf({ sourceRef: 'https://bank.example/overview' })), 'sourceRef');
    assert.equal(refused(dom({ sourceRef: '/account/overview' })), 'sourceRef', 'no page path is allowlisted in A1');
    assert.equal(refused(pdf({ sourceRef: `sha256:${'C'.repeat(64)}` })), 'sourceRef');
  });

  it('a card reference may name its owner and its nickname, each checked; a reference without them is what it always was', () => {
    const plain = valid(pdf());
    assert.deepEqual(plain.card, { issuer: 'testbank', last4: '1234', last5: null });
    const named = valid(pdf({ card: { issuer: 'testbank', last4: '1234', owner: 'casey', nickname: '  Sample \t Gold ' } }));
    assert.deepEqual(named.card, { issuer: 'testbank', last4: '1234', last5: null, owner: 'casey', nickname: 'Sample Gold' });
    assert.equal(refused(pdf({ card: { issuer: 'testbank', last4: '1234', owner: 'neighbor' } })), 'card.owner');
    assert.equal(refused(pdf({ card: { issuer: 'testbank', last4: '1234', owner: null } })), 'card.owner');
    for (const nickname of ['', '   ', 'x'.repeat(81), 'Gold\u200b', 'Card 4111111111111111', 42, null]) {
      assert.equal(refused(pdf({ card: { issuer: 'testbank', last4: '1234', nickname } })), 'card.nickname', String(nickname));
    }
    // A held row's identity hashes its reference: without the new keys it hashes exactly as before them.
    assert.equal(cardSchedulePayloadDigest(plain, { unboundCard: plain.card }, 'unbound'),
      cardSchedulePayloadDigest(plain, { unboundCard: { issuer: 'testbank', last4: '1234', last5: null } }, 'unbound'));
    assert.equal(cardNicknameKey(' Sample  GOLD '), cardNicknameKey('sample gold'));
    assert.notEqual(cardNicknameKey('Sample Gold'), cardNicknameKey('Sample Platinum'));
  });
});

describe('cardSchedulePayloadDigest', () => {
  it('excludes the capture time and extractor version; includes the binding, the facts and the held reason', () => {
    const a = valid(pdf());
    const b = valid(pdf({ observedAt: '2026-10-09T12:00:00Z', extractorVersion: 'testbank-statement@2' }));
    const card = { cardAccountId: 'card-a' };
    assert.equal(cardSchedulePayloadDigest(a, card, null), cardSchedulePayloadDigest(b, card, null));
    assert.match(cardSchedulePayloadDigest(a, card, null), /^[0-9a-f]{64}$/);
    assert.notEqual(cardSchedulePayloadDigest(a, card, null), cardSchedulePayloadDigest(a, { cardAccountId: 'card-b' }, null));
    assert.notEqual(cardSchedulePayloadDigest(a, card, null), cardSchedulePayloadDigest(valid(pdf({ pastDueMinor: 1 })), card, null));
    assert.notEqual(cardSchedulePayloadDigest(a, card, null), cardSchedulePayloadDigest(a, card, 'minimum-basis'));
    assert.notEqual(cardSchedulePayloadDigest(a, card, null), cardSchedulePayloadDigest(a, { unboundCard: a.card }, null));
  });
});
