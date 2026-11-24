import { describe, expect, it } from 'vitest';

import { parseActivityRow, type ActivityRow } from './activityParser.js';
import {
  cashEventFromActivity,
  computeCashEventFingerprint,
  type CashEventCandidate,
} from './cashEvents.js';

function row(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    date: 'May-07-2026',
    accountLabel: 'Brokerage ***2468',
    description: 'DIVIDEND RECEIVED SYNTHETIC FUND (TEST) (Cash)',
    amount: '+$12.34',
    ...overrides,
  };
}

describe('cashEventFromActivity', () => {
  it('maps a dividend to a positive typed cash event', () => {
    expect(cashEventFromActivity(parseActivityRow(row()))).toEqual({
      kind: 'cash-event',
      event: {
        date: '2026-05-07',
        eventType: 'dividend',
        amount: 12.34,
        accountLast4: '2468',
        description: 'DIVIDEND RECEIVED SYNTHETIC FUND (TEST) (Cash)',
      },
    });
  });

  it('maps ACH direction to deposit or withdrawal from the signed amount', () => {
    const deposit = cashEventFromActivity(parseActivityRow(row({
      description: 'Electronic Funds Transfer Received (Cash)',
      amount: '+$250.00',
    })));
    const withdrawal = cashEventFromActivity(parseActivityRow(row({
      description: 'Electronic Funds Transfer Paid (Cash)',
      amount: '-$75.00',
    })));
    expect(deposit).toMatchObject({ kind: 'cash-event', event: { eventType: 'deposit', amount: 250 } });
    expect(withdrawal).toMatchObject({ kind: 'cash-event', event: { eventType: 'withdrawal', amount: -75 } });
  });

  it('keeps transfer direction in the signed amount', () => {
    expect(cashEventFromActivity(parseActivityRow(row({
      description: 'TRANSFERRED FROM EXTERNAL ACCOUNT (Cash)',
      amount: '+$500.00',
    })))).toMatchObject({
      kind: 'cash-event',
      event: { eventType: 'transfer', amount: 500 },
    });
  });

  it('rejects cash rows with invalid date, account, amount, or zero amount', () => {
    expect(cashEventFromActivity(parseActivityRow(row({ date: 'Feb-30-2026' })))).toMatchObject({ kind: 'invalid-cash-event' });
    expect(cashEventFromActivity(parseActivityRow(row({ accountLabel: '' })))).toMatchObject({ kind: 'invalid-cash-event' });
    expect(cashEventFromActivity(parseActivityRow(row({ amount: 'not money' })))).toMatchObject({ kind: 'invalid-cash-event' });
    expect(cashEventFromActivity(parseActivityRow(row({ amount: '$0.00' })))).toMatchObject({ kind: 'invalid-cash-event' });
  });

  it('does not classify a security trade as a cash event', () => {
    expect(cashEventFromActivity(parseActivityRow(row({
      description: 'YOU BOUGHT WIDGET CORP (WDGT) (Cash)',
      amount: '-$10.00',
      quantity: '1',
      pricePerUnit: '$10.00',
    })))).toEqual({ kind: 'not-cash-event' });
  });
});

describe('computeCashEventFingerprint', () => {
  const event: CashEventCandidate = {
    date: '2026-05-07',
    eventType: 'dividend',
    amount: 12.34,
    accountLast4: '2468',
    description: 'DIVIDEND RECEIVED SYNTHETIC FUND (TEST) (Cash)',
  };

  it('is stable and returns lowercase SHA-256 hex', () => {
    const fingerprint = computeCashEventFingerprint('fidelity', event, 0);
    expect(fingerprint).toBe(computeCashEventFingerprint('fidelity', event, 0));
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('distinguishes amount, normalized description, and exact-row occurrence', () => {
    const base = computeCashEventFingerprint('fidelity', event, 0);
    expect(computeCashEventFingerprint('fidelity', { ...event, amount: 12.35 }, 0)).not.toBe(base);
    expect(computeCashEventFingerprint('fidelity', { ...event, description: 'DIFFERENT DIVIDEND' }, 0)).not.toBe(base);
    expect(computeCashEventFingerprint('fidelity', event, 1)).not.toBe(base);
  });

  it('normalizes harmless whitespace and case changes in descriptions', () => {
    const a = computeCashEventFingerprint('fidelity', event, 0);
    const b = computeCashEventFingerprint('FIDELITY', {
      ...event,
      description: '  dividend   received synthetic fund (test) (cash) ',
    }, 0);
    expect(a).toBe(b);
  });
});