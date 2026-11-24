import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_PAYMENT_SOURCE_EVENT_TYPES,
  CARD_PAYMENT_SOURCE_RULES,
  cardPaymentSourceWindow,
  cashAmountToMinor,
  countCardPaymentSources,
  isCardPaymentToCard,
  suggestCardPaymentSources,
  type CardPaymentCashEvent,
  type CardPaymentRow,
} from './cardPayments.js';

// Synthetic rows only: made-up amounts, dates, account and event ids.
function payment(overrides: Partial<CardPaymentRow> = {}): CardPaymentRow {
  return {
    id: 'card-txn-pay', transactionDate: '2026-09-25', status: 'posted', amountMinor: -60000, currency: 'USD', kind: 'payment',
    ...overrides,
  };
}

function cash(id: string, overrides: Partial<CardPaymentCashEvent> = {}): CardPaymentCashEvent {
  return { id, accountId: 'acct-brokerage-a', date: '2026-09-26', eventType: 'withdrawal', amount: -600, currency: 'USD', ...overrides };
}

const ids = (items: Array<{ cashEventId: string }>) => items.map((item) => item.cashEventId);

describe('cashAmountToMinor', () => {
  it('reads a stored amount as exact minor units of its currency', () => {
    assert.equal(cashAmountToMinor(-600, 'USD'), -60000);
    assert.equal(cashAmountToMinor(600.1, 'USD'), 60010);
    assert.equal(cashAmountToMinor(-1234567.89, 'USD'), -123456789);
    assert.equal(cashAmountToMinor(0.07, 'USD'), 7);
    assert.equal(cashAmountToMinor(-5000, 'JPY'), -5000);
    assert.equal(cashAmountToMinor(-12.345, 'KWD'), -12345);
    assert.equal(cashAmountToMinor(-0.001, 'KWD'), -1);
  });

  it('refuses fractions of the minor unit, float noise and anything not finite or exact', () => {
    assert.equal(cashAmountToMinor(-600.004, 'USD'), null);
    assert.equal(cashAmountToMinor(-0.001, 'USD'), null);
    assert.equal(cashAmountToMinor(-5000.5, 'JPY'), null);
    // 0.1 + 0.2 is 0.30000000000000004, not 0.30: no float is rounded into a match.
    assert.equal(cashAmountToMinor(0.1 + 0.2, 'USD'), null);
    assert.equal(cashAmountToMinor(Number.NaN, 'USD'), null);
    assert.equal(cashAmountToMinor(Number.NEGATIVE_INFINITY, 'USD'), null);
    assert.equal(cashAmountToMinor(-1e21, 'USD'), null);
    assert.equal(cashAmountToMinor(1e-7, 'USD'), null);
    assert.equal(cashAmountToMinor(-900719925474099.5, 'USD'), null);
    assert.equal(cashAmountToMinor('600' as never, 'USD'), null);
  });
});

describe('isCardPaymentToCard and cardPaymentSourceWindow', () => {
  it('takes card payments of money to the card that are pending or posted', () => {
    assert.equal(isCardPaymentToCard(payment()), true);
    assert.equal(isCardPaymentToCard(payment({ status: 'pending' })), true);
    assert.equal(isCardPaymentToCard(payment({ status: 'removed' })), false);
    // A returned payment puts money back; refunds, credits and purchases are not payments.
    assert.equal(isCardPaymentToCard(payment({ amountMinor: 60000 })), false);
    assert.equal(isCardPaymentToCard(payment({ kind: 'refund' })), false);
    assert.equal(isCardPaymentToCard(payment({ kind: 'adjustment' })), false);
    assert.equal(isCardPaymentToCard(payment({ kind: 'purchase', amountMinor: 60000 })), false);
    assert.equal(isCardPaymentToCard(payment({ amountMinor: -0.5 })), false);
  });

  it('spans the rule days around the payments, across month and year ends', () => {
    assert.deepEqual(CARD_PAYMENT_SOURCE_RULES, { daysBefore: 5, daysAfter: 5, maxSuggestions: 3 });
    assert.deepEqual(cardPaymentSourceWindow('2026-01-03'), { from: '2025-12-29', to: '2026-01-08' });
    assert.deepEqual(cardPaymentSourceWindow('2026-09-01', '2026-09-30'), { from: '2026-08-27', to: '2026-10-05' });
    assert.deepEqual(cardPaymentSourceWindow('2028-02-27'), { from: '2028-02-22', to: '2028-03-03' });
    assert.deepEqual(cardPaymentSourceWindow('9999-12-30'), { from: '9999-12-25', to: '9999-12-31' });
    assert.deepEqual(cardPaymentSourceWindow('0000-01-02'), { from: '0000-01-01', to: '0000-01-07' });
    assert.equal(cardPaymentSourceWindow('2026-02-30'), null);
    assert.equal(cardPaymentSourceWindow('2026-9-1'), null);
    assert.equal(cardPaymentSourceWindow('2026-09-30', '2026-09-01'), null);
  });
});

describe('suggestCardPaymentSources', () => {
  it('suggests withdrawals and outgoing transfers of exactly the amount and currency, closest first, at most three', () => {
    assert.deepEqual(CARD_PAYMENT_SOURCE_EVENT_TYPES, ['withdrawal', 'transfer']);
    const events = [
      cash('in-window-late', { date: '2026-09-30' }),
      cash('too-late', { date: '2026-10-01' }),
      cash('next-day', { date: '2026-09-26' }),
      cash('too-early', { date: '2026-09-19' }),
      cash('two-before', { date: '2026-09-23', eventType: 'transfer', accountId: 'acct-brokerage-b' }),
      cash('in-window-early', { date: '2026-09-20' }),
      cash('a-cent-more', { date: '2026-09-25', amount: -600.01 }),
      cash('fraction-of-a-cent', { date: '2026-09-25', amount: -600.004 }),
      cash('same-number-in-euros', { date: '2026-09-25', currency: 'EUR' }),
      cash('fee', { date: '2026-09-25', eventType: 'fee' }),
      cash('tax', { date: '2026-09-25', eventType: 'tax' }),
      cash('sweep', { date: '2026-09-25', eventType: 'sweep' }),
      cash('transfer-in', { date: '2026-09-25', eventType: 'transfer', amount: 600 }),
      cash('deposit', { date: '2026-09-25', eventType: 'deposit', amount: 600 }),
      cash('dividend', { date: '2026-09-25', eventType: 'dividend', amount: 600 }),
      cash('interest', { date: '2026-09-25', eventType: 'interest', amount: 600 }),
      cash('bad-date', { date: '2026-09-31' }),
    ];
    const suggested = suggestCardPaymentSources(payment(), events);
    assert.deepEqual(ids(suggested), ['next-day', 'two-before', 'in-window-early']);
    assert.deepEqual(suggested[0], {
      cashEventId: 'next-day', accountId: 'acct-brokerage-a', date: '2026-09-26', eventType: 'withdrawal',
      amountMinor: -60000, currency: 'USD', dayOffset: 1,
    });
    assert.deepEqual(suggested.map((item) => item.dayOffset), [1, -2, -5]);
    // Five days either way, the earlier one first on a tie.
    assert.deepEqual(ids(suggestCardPaymentSources(payment(), events, Infinity)), ['next-day', 'two-before', 'in-window-early', 'in-window-late']);
    assert.deepEqual(suggestCardPaymentSources(payment(), events, 0), []);
  });

  it('never pairs equal numbers across currencies, and compares each currency in its own minor unit', () => {
    const usd = payment({ amountMinor: -5000 });
    assert.deepEqual(suggestCardPaymentSources(usd, [cash('yen', { amount: -5000, currency: 'JPY' }), cash('yen-50', { amount: -50, currency: 'JPY' })]), []);
    const yen = payment({ amountMinor: -5000, currency: 'JPY' });
    assert.deepEqual(ids(suggestCardPaymentSources(yen, [
      cash('yen', { amount: -5000, currency: 'JPY' }),
      cash('dollars', { amount: -50, currency: 'USD' }),
      cash('half-yen', { amount: -5000.5, currency: 'JPY' }),
    ])), ['yen']);
    const dinar = payment({ amountMinor: -12345, currency: 'KWD' });
    assert.deepEqual(ids(suggestCardPaymentSources(dinar, [cash('dinar', { amount: -12.345, currency: 'KWD' })])), ['dinar']);
  });

  it('suggests nothing for rows that are not payments to the card', () => {
    const events = [cash('withdrawal', { date: '2026-09-25' }), cash('deposit', { date: '2026-09-25', eventType: 'deposit', amount: 600 })];
    for (const row of [
      payment({ kind: 'refund' }),
      payment({ kind: 'purchase', amountMinor: 60000 }),
      payment({ amountMinor: 60000 }),
      payment({ status: 'removed' }),
      payment({ transactionDate: '2026-13-01' }),
    ]) {
      assert.deepEqual(suggestCardPaymentSources(row, events), [], JSON.stringify(row));
    }
    assert.deepEqual(ids(suggestCardPaymentSources(payment({ status: 'pending' }), events)), ['withdrawal']);
  });

  it('orders ties the same way whatever the input order', () => {
    const events = [
      cash('b-after', { date: '2026-09-26', accountId: 'acct-b' }),
      cash('a-after', { date: '2026-09-26', accountId: 'acct-a' }),
      cash('a-before', { date: '2026-09-24', accountId: 'acct-a' }),
      cash('a-after-2', { date: '2026-09-26', accountId: 'acct-a' }),
    ];
    const expected = ['a-before', 'a-after', 'a-after-2'];
    assert.deepEqual(ids(suggestCardPaymentSources(payment(), events)), expected);
    assert.deepEqual(ids(suggestCardPaymentSources(payment(), [...events].reverse())), expected);
  });
});

describe('countCardPaymentSources', () => {
  it('counts each outflow for at most one payment, per currency', () => {
    const first = payment({ id: 'p1', transactionDate: '2026-09-10', amountMinor: -50000 });
    const second = payment({ id: 'p2', transactionDate: '2026-09-12', amountMinor: -50000 });
    const one = cash('w1', { date: '2026-09-11', amount: -500 });
    assert.deepEqual(countCardPaymentSources([first, second], [one]), [{ currency: 'USD', count: 1 }]);
    assert.deepEqual(countCardPaymentSources([first, second], [one, cash('w2', { date: '2026-09-13', amount: -500 })]), [
      { currency: 'USD', count: 2 },
    ]);
    // Pairing p2 with w1 first would leave p1 without one: the count is the most payments paired one-to-one.
    assert.deepEqual(countCardPaymentSources([second, first], [one, cash('w3', { date: '2026-09-16', amount: -500 })]), [
      { currency: 'USD', count: 2 },
    ]);
  });

  it('lists every currency with payments to the card, and ignores everything else', () => {
    const counts = countCardPaymentSources([
      payment({ id: 'usd', amountMinor: -60000 }),
      payment({ id: 'eur', currency: 'EUR', amountMinor: -60000 }),
      payment({ id: 'returned', currency: 'GBP', amountMinor: 60000 }),
      payment({ id: 'purchase', currency: 'CAD', kind: 'purchase', amountMinor: 60000 }),
      payment({ id: 'gone', currency: 'CHF', status: 'removed' }),
    ], [cash('w-usd'), cash('w-eur-number', { currency: 'USD', amount: -600 })]);
    assert.deepEqual(counts, [{ currency: 'EUR', count: 0 }, { currency: 'USD', count: 1 }]);
    assert.deepEqual(countCardPaymentSources([], [cash('w-usd')]), []);
  });
});
