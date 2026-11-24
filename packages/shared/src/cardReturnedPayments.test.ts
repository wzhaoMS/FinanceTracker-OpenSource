import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCardKind, isReturnedCardPaymentCharge } from './cardKinds.js';
import { convertCardExport } from './cardImportTool/convert.js';
import { cardCategoryInferable } from './cardCategoryInference.js';
import { computeCardInsights, findRecurringCharges } from './cardInsights.js';
import { cardSpendingWindow, classifyCardSpending } from './cardSpendingCompare.js';
import { buildCardSpendingAccounting } from './cardSpendingExclusions.js';
import { cardSpendingPatterns, forecastCardSpending } from './cardSpendingForecast.js';
import {
  effectiveCardKind,
  readCardSpendingRow,
  readCardSpendingRows,
  summarizeCardSpending,
  toCardTransactionView,
} from './cardSpending.js';
import type { CardTransaction, CardTransactionKind } from './types.js';

// A payment from the bank to the card that the bank returned, and the issuer debited back: no spending, wherever
// Spending counts. Synthetic rows only: made-up merchants, amounts, dates and card ids; "RETURNED ONLINE ACH PAYMENT" is
// issuer wording.

const FEES = 'Fees & Adjustments-Fees & Adjustments';
const GROCERIES = 'Merchandise & Supplies-Groceries';
const RETURNED = /RETURNED (?:ONLINE|MOBILE) ACH PAYMENT$/i;

/** A stored row, with the kind it was stored with. */
function stored(transactionDate: string, description: string, amountMinor: number, kind: CardTransactionKind, patch: Partial<CardTransaction> = {}): CardTransaction {
  return {
    id: `${transactionDate}:${description}:${amountMinor}`, cardAccountId: 'card-a', source: 'test-sync', transactionDate,
    status: 'posted', amountMinor, currency: 'USD', kind, description, createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z', ...patch,
  };
}

/** A row as a converter stores it: kinded by the import classifier from its words and its issuer's category. */
function converted(transactionDate: string, description: string, amountMinor: number, issuerCategory?: string): CardTransaction {
  const kind = classifyCardKind({ amountMinor, description, issuerCategory: issuerCategory ?? null });
  return stored(transactionDate, description, amountMinor, kind, issuerCategory === undefined ? {} : { issuerCategory });
}

describe('a charge that takes a card payment back', () => {
  it('is read from its own words, never from a fee\'s, a charge\'s, a penalty\'s or interest\'s', () => {
    const charge = (description: string, merchant: string | null = null) => ({ amountMinor: 150_000, description, merchant });
    for (const description of [
      'RETURNED ONLINE ACH PAYMENT', 'Returned Mobile ACH Payment', 'RETURNED PAYMENT', 'PAYMENT RETURNED', 'ONLINE PAYMENT REVERSED',
      'REVERSAL - AUTOMATIC PAYMENT', 'PAYMENT DISHONOURED', 'NSF RETURNED AUTOPAY', 'RETURNED AUTOPMT', 'AUTOPAY PAYMENT REVERSAL',
    ]) {
      assert.equal(isReturnedCardPaymentCharge(charge(description)), true, description);
    }
    // Either text, read on its own: an issuer's own words beside a network descriptor.
    assert.equal(isReturnedCardPaymentCharge(charge('SAMPLE BANK', 'Returned Online ACH Payment')), true);
    for (const description of [
      // A fee for a returned payment, however it is worded, is a cost; so is interest.
      'RETURNED PAYMENT FEE', 'RETURNED ONLINE ACH PAYMENT FEE', 'NSF PAYMENT FEE', 'RETURNED PAYMENT CHARGE', 'RETURNED PAYMENT PENALTY',
      'LATE PAYMENT FEE', 'INTEREST CHARGE ON PURCHASES', 'RETURNED PAYMENT INTEREST',
      // A payment word without a return word (a bill paid with the card, a tax), a return word without a payment word.
      'ONLINE PAYMENT', 'SAMPLE UTILITY BILL PAYMENT', 'US TREASURY TAX PAYMENT', 'SAMPLE TAX RETURN PAYMENT',
      'NORTHWIND RETURNED ITEM SHIPPING', 'NORTHWIND GROCERY',
    ]) {
      assert.equal(isReturnedCardPaymentCharge(charge(description)), false, description);
    }
    assert.equal(isReturnedCardPaymentCharge(charge('RETURNED ONLINE ACH PAYMENT', 'SAMPLE FEES')), false);
    // A charge only: never a credit or a zero amount.
    assert.equal(isReturnedCardPaymentCharge({ amountMinor: -150_000, description: 'RETURNED ONLINE ACH PAYMENT' }), false);
    assert.equal(isReturnedCardPaymentCharge({ amountMinor: 0, description: 'RETURNED ONLINE ACH PAYMENT' }), false);
  });

  it('is a card payment whatever spending kind it was stored with, unless the owner filed it under a category of their own', () => {
    const returned = (kind: CardTransactionKind, patch: Partial<CardTransaction> = {}) =>
      stored('2026-09-12', 'RETURNED ONLINE ACH PAYMENT', 150_000, kind, patch);
    for (const kind of ['purchase', 'fee', 'interest', 'adjustment', 'payment'] as const) {
      assert.equal(effectiveCardKind(returned(kind)), 'payment', kind);
    }
    // A row that is no spending stays as it is: an `other` row is listed, never counted.
    assert.equal(effectiveCardKind(returned('other')), 'other');
    // The owner's own category comes first: the row counts as they filed it.
    assert.equal(effectiveCardKind(returned('purchase', { userCategory: 'Sample bank charges' })), 'purchase');
    assert.equal(effectiveCardKind(returned('fee', { userCategory: 'Precious metals' })), 'fee');
    for (const [description, amountMinor, kind] of [
      ['NORTHWIND GROCERY', 6_250, 'purchase'], ['RETURNED PAYMENT FEE', 2_900, 'fee'], ['INTEREST CHARGE ON PURCHASES', 1_234, 'interest'],
      ['CONTOSO OUTFITTERS', -9_900, 'refund'], ['ONLINE ACH PAYMENT - THANK YOU', -150_000, 'payment'],
    ] as const) {
      assert.equal(effectiveCardKind(stored('2026-09-12', description, amountMinor, kind)), kind, description);
    }
    // Read, never written: the stored row is untouched, and a row read as its own kind is that very row.
    const row = returned('purchase');
    assert.deepEqual(readCardSpendingRow(row), { ...row, kind: 'payment' });
    assert.equal(row.kind, 'purchase');
    const grocery = stored('2026-09-02', 'NORTHWIND GROCERY', 6_250, 'purchase');
    assert.equal(readCardSpendingRow(grocery), grocery);
    // Its view says the kind it is read as, and that it is a transfer.
    const view = toCardTransactionView(row);
    assert.deepEqual([view.kind, view.role, view.amountMinor], ['payment', 'transfer', 150_000]);
  });
});

describe('returned card payments through the spending reads, from the import classifier', () => {
  // The issuer's words and categories as converters store them; one return as a producer that kinds rows itself stored it.
  const rows = [
    converted('2026-09-02', 'NORTHWIND GROCERY', 6_250, GROCERIES),
    converted('2026-09-05', 'ONLINE ACH PAYMENT - THANK YOU', -150_000),
    stored('2026-09-12', 'RETURNED ONLINE ACH PAYMENT', 150_000, 'purchase'),
    converted('2026-09-06', 'MOBILE ACH PAYMENT', -80_000),
    converted('2026-09-14', 'RETURNED MOBILE ACH PAYMENT', 80_000, FEES),
    converted('2026-09-15', 'RETURNED PAYMENT FEE', 2_900, FEES),
    converted('2026-09-16', 'RETURNED ONLINE ACH PAYMENT FEE', 3_500, FEES),
    converted('2026-09-18', 'CONTOSO OUTFITTERS', 9_900),
    converted('2026-09-20', 'INTEREST CHARGE ON PURCHASES', 1_234),
    converted('2026-09-21', 'LATE FEE', 4_000),
    converted('2026-09-25', 'CONTOSO OUTFITTERS', -9_900),
  ];
  const returns = new Set([rows[2].id, rows[4].id]);
  const read = readCardSpendingRows(rows);

  it('reads the returns as card payments and every other row as stored', () => {
    // The import classifier makes a fee of a return its issuer files under fees.
    assert.deepEqual(rows.map((row) => row.kind),
      ['purchase', 'payment', 'purchase', 'payment', 'fee', 'fee', 'fee', 'purchase', 'interest', 'fee', 'refund']);
    assert.deepEqual(read.map((row) => row.kind),
      ['purchase', 'payment', 'payment', 'payment', 'payment', 'fee', 'fee', 'purchase', 'interest', 'fee', 'refund']);
    read.forEach((row, index) => assert.equal(row === rows[index], !returns.has(row.id), row.description));
  });

  it('nets each payment and its return to zero, and leaves purchases, refunds, fees and interest as they were', () => {
    const before = summarizeCardSpending(rows);
    const after = summarizeCardSpending(read);
    const withoutReturns = summarizeCardSpending(rows.filter((row) => !returns.has(row.id)));
    // Exactly the summary without the returns, but for the payments: each return counts against the payment it reverses.
    assert.deepEqual({ ...after, totals: [] }, { ...withoutReturns, totals: [] });
    const { paymentsMinor, paymentCount, ...spending } = after.totals[0];
    const { paymentsMinor: _paid, paymentCount: _payments, ...spendingWithout } = withoutReturns.totals[0];
    assert.deepEqual(spending, spendingWithout);
    assert.deepEqual([paymentsMinor, paymentCount], [0, 4]);
    assert.deepEqual(spending, {
      currency: 'USD', spendingMinor: 6_250 + 2_900 + 3_500 + 9_900 + 1_234 + 4_000 - 9_900,
      chargesMinor: 6_250 + 2_900 + 3_500 + 9_900 + 1_234 + 4_000, creditsMinor: -9_900, count: 7, otherMinor: 0, otherCount: 0,
    });
    // A fee for a returned payment is still a fee, filed where its issuer filed it.
    assert.deepEqual(after.byCategory.find((item) => item.category === FEES), {
      category: FEES, currency: 'USD', spendingMinor: 2_900 + 3_500, chargesMinor: 2_900 + 3_500, creditsMinor: 0, count: 2,
    });
    // As stored, both returns were spending and their payments were left unanswered.
    assert.equal(before.totals[0].spendingMinor - after.totals[0].spendingMinor, 150_000 + 80_000);
    assert.deepEqual([before.totals[0].paymentsMinor, before.totals[0].paymentCount], [-230_000, 2]);
  });

  it('keeps every posted row in the card\'s activity: a return still adds to what the card owes', () => {
    const [beforeBook] = buildCardSpendingAccounting(rows);
    const [afterBook] = buildCardSpendingAccounting(read);
    assert.deepEqual(afterBook.activity, beforeBook.activity);
    assert.equal(afterBook.activity.netMinor, rows.reduce((sum, row) => sum + row.amountMinor, 0));
    assert.deepEqual(afterBook.transfers, { netMinor: 0, chargesMinor: 230_000, creditsMinor: -230_000, count: 4 });
    assert.equal(afterBook.spending.netMinor, summarizeCardSpending(read).totals[0].spendingMinor);
  });

  it('a payment and its return alone: no spending at all', () => {
    const summary = summarizeCardSpending(readCardSpendingRows([rows[1], rows[2]]));
    assert.deepEqual(summary.totals, [{
      currency: 'USD', spendingMinor: 0, chargesMinor: 0, creditsMinor: 0, count: 0, paymentsMinor: 0, paymentCount: 2, otherMinor: 0, otherCount: 0,
    }]);
    assert.deepEqual([summary.byMonth, summary.byCategory, summary.byMerchant, summary.byCard], [[], [], [], []]);
  });

  it('counts a return the owner filed under a category of their own, as filed', () => {
    const filed = readCardSpendingRows([rows[1], { ...rows[2], userCategory: 'Sample bank charges' }]);
    const summary = summarizeCardSpending(filed);
    assert.deepEqual(summary.byCategory.map((item) => [item.category, item.spendingMinor, item.count]), [['Sample bank charges', 150_000, 1]]);
    assert.deepEqual([summary.totals[0].paymentsMinor, summary.totals[0].paymentCount], [-150_000, 1]);
  });

  it('files no category for a return, and counts no fee for one', () => {
    assert.equal(cardCategoryInferable(rows[2]), true);
    assert.equal(cardCategoryInferable(read[2]), false);
    const costs = computeCardInsights(read, { month: '2026-09', today: '2026-09-30', currency: 'USD' }).costs.period;
    assert.deepEqual([costs.feesMinor, costs.interestMinor], [2_900 + 3_500 + 4_000, 1_234]);
  });
});

describe('returns that showed as a recurring charge', () => {
  // Every month a payment, and the bank returning it: stored as purchases, they were a monthly "charge".
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  const rows = months.flatMap((month, index) => [
    converted(`${month}-03`, 'ONLINE ACH PAYMENT - THANK YOU', -120_000),
    stored(`${month}-10`, 'RETURNED ONLINE ACH PAYMENT', 120_000, 'purchase'),
    converted(`${month}-15`, 'SAMPLE STREAMING SERVICE', 1_599),
    converted(`${month}-20`, 'NORTHWIND GROCERY', 6_000 + index * 250, GROCERIES),
  ]);
  const read = readCardSpendingRows(rows);
  const today = '2026-09-30';
  const named = (names: readonly string[]) => names.filter((name) => RETURNED.test(name));

  it('are no recurring charge, and no part of a period\'s spending', () => {
    assert.equal(named(findRecurringCharges(rows, today).map((charge) => charge.merchant)).length, 1);
    const recurring = findRecurringCharges(read, today).map((charge) => charge.merchant);
    assert.deepEqual(named(recurring), []);
    assert.ok(recurring.includes('SAMPLE STREAMING SERVICE'), recurring.join(', '));

    const window = (list: readonly CardTransaction[]) => cardSpendingWindow(
      classifyCardSpending(list, { currency: 'USD', through: today, today }), { from: '2026-07-01', to: today });
    const before = window(rows);
    const after = window(read);
    assert.deepEqual(named(before.recurring.map((line) => line.name)).length, 1);
    assert.deepEqual(named(after.recurring.map((line) => line.name)), []);
    assert.equal(before.spendingMinor - after.spendingMinor, 3 * 120_000);
    const inWindow = read.filter((row) => row.transactionDate >= '2026-07-01');
    assert.equal(after.spendingMinor, summarizeCardSpending(inWindow).totals[0].spendingMinor);
    assert.equal(after.spendingMinor, after.recurringMinor + after.oneOffMinor + after.everydayMinor);
  });

  it('are in no month the forecast fits, and no bill the patterns expect', () => {
    const input = { today: '2026-10-05', currency: 'USD', completeMonths: new Set(months) };
    const spendingOf = (list: readonly CardTransaction[]) =>
      new Map(forecastCardSpending(list, input).months.map((month) => [month.month, month.spendingMinor]));
    const before = spendingOf(rows);
    const after = spendingOf(read);
    const summary = new Map(summarizeCardSpending(read).byMonth.map((month) => [month.month, month.spendingMinor]));
    for (const month of months) {
      assert.equal(after.get(month), summary.get(month), month);
      assert.equal((before.get(month) ?? 0) - (after.get(month) ?? 0), 120_000, month);
    }
    const bills = (list: readonly CardTransaction[]) => cardSpendingPatterns(list, input).bills.items.map((bill) => bill.merchant);
    assert.deepEqual(named(bills(read)), []);
    assert.ok(bills(read).includes('SAMPLE STREAMING SERVICE'));
  });
});

describe('a returned payment the issuer cut short (Capital One\'s OFX cuts every name at 25 characters)', () => {
  // The issuer's own forms, cut mid-word; description and merchant alike, as the converter stores an OFX name.
  const ONLINE = 'Returned Online ACH Payme';
  const MOBILE = 'Returned Mobile ACH Payme';
  const CUT = /^Returned (?:Online|Mobile) ACH Payme$/;
  const charge = (description: string, kind: CardTransactionKind = 'purchase', merchant: string | null = description) =>
    ({ amountMinor: 150_000, description, merchant, kind });

  it('is read from a return word and a payment word cut off at the end, on a row stored as a purchase', () => {
    assert.deepEqual([ONLINE.length, MOBILE.length], [25, 25]);
    for (const description of [ONLINE, MOBILE, 'RETURNED ONLINE ACH PAYM', 'RETURNED ONLINE ACH PAYMEN', 'NSF MOBILE PAYMENTS', 'REVERSED ACH PMT']) {
      assert.equal(isReturnedCardPaymentCharge(charge(description)), true, description);
      assert.equal(isReturnedCardPaymentCharge(charge(description, 'purchase', null)), true, description);
    }
    // In the merchant alone, as an OFX name beside a memo of its own.
    assert.equal(isReturnedCardPaymentCharge(charge(`${ONLINE} SAMPLE MEMO`, 'purchase', ONLINE)), true);
    for (const description of [
      // A merchant whose name starts with PAYM, with a return word or without, and a cut word without a return word.
      'PAYMENTUS*SAMPLE CITY UTILITY', 'Paymentus', 'SAMPLE PAYMENTUS', 'SAMPLE ONLINE ACH PAYME', 'SAMPLE PAYM',
      'RETURNED ITEM PAYMENTUS', 'RETURNED PAYMASTER',
      // Too little of the word left, or not at the end.
      'RETURNED ONLINE ACH PAY', 'RETURNED ONLINE ACH PA', 'RETURNED PAYME SAMPLE',
      // A cost.
      'RETURNED PAYMENT FEE', 'NSF PAYM FEE',
    ]) {
      assert.equal(isReturnedCardPaymentCharge(charge(description)), false, description);
    }
    // Only a row stored as a purchase: a fee cut short before its FEE reads the same, so a fee (the issuer's type or
    // category) stays one. Given no kind, whole words only.
    for (const kind of ['fee', 'interest', 'adjustment', 'refund', 'payment', 'other'] as const) {
      assert.equal(isReturnedCardPaymentCharge(charge(ONLINE, kind)), false, kind);
    }
    assert.equal(isReturnedCardPaymentCharge({ amountMinor: 150_000, description: ONLINE }), false);
    // A charge only.
    assert.equal(isReturnedCardPaymentCharge({ ...charge(ONLINE), amountMinor: -150_000 }), false);
  });

  it('reads such a stored purchase as a card payment, unless the owner filed it under a category of their own', () => {
    for (const description of [ONLINE, MOBILE]) {
      const row = stored('2026-07-10', description, 150_000, 'purchase', { merchant: description });
      assert.equal(effectiveCardKind(row), 'payment', description);
      assert.equal(effectiveCardKind({ ...row, userCategory: 'Sample bank charges' }), 'purchase', description);
      assert.equal(effectiveCardKind({ ...row, kind: 'fee' }), 'fee', description);
      const view = toCardTransactionView(row);
      assert.deepEqual([view.kind, view.role, view.amountMinor], ['payment', 'transfer', 150_000], description);
    }
  });

  it('from the converter to the summary, the overview, insights and the forecast: each nets against the payment it reverses', () => {
    const money = (minor: number) => (minor / 100).toFixed(2);
    // Holdr's sign: money spent positive. Each month a payment by each channel and the bank returning it, the name cut
    // where the issuer cuts it; a subscription, groceries; in July a bill paid through a "Paym..." merchant, a late fee,
    // interest and a refund.
    const lines: Array<[date: string, minor: number, name: string]> = [];
    for (const month of ['05', '06', '07']) {
      lines.push([`2026${month}03`, -150_000, 'Mobile ACH Payment'], [`2026${month}10`, 150_000, MOBILE],
        [`2026${month}05`, -220_000, 'Online ACH Payment'], [`2026${month}12`, 220_000, ONLINE],
        [`2026${month}15`, 1_599, 'SAMPLE STREAMING SERVICE'], [`2026${month}20`, 6_250, 'SAMPLE GROCERY']);
    }
    lines.push(['20260718', 8_000, 'PAYMENTUS*SAMPLE CITY UTILITY'], ['20260721', 2_900, 'LATE FEE'],
      ['20260725', 1_234, 'INTEREST CHARGE ON PURCHASES'], ['20260726', -1_000, 'SAMPLE GROCERY']);
    const ofx = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD</CURDEF><CCACCTFROM><ACCTID>XXXX-1111</ACCTID></CCACCTFROM><BANKTRANLIST>',
      ...lines.map(([date, minor, name], index) => `<STMTTRN><TRNTYPE>${minor > 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${date}</DTPOSTED>`
        + `<TRNAMT>${money(-minor)}</TRNAMT><FITID>SYN-CUT-${index}</FITID><NAME>${name}</NAME></STMTTRN>`),
      '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>'].join('\n');
    const { payload } = convertCardExport(new Uint8Array(Buffer.from(ofx, 'utf8')), { format: 'ofx', issuer: 'capitalone', status: 'posted' });
    // As production stored them: the returns as purchases, the cut name as both texts, no category; the payments as payments.
    const returns = payload.rows.filter((row) => CUT.test(row.description));
    assert.equal(returns.length, 6);
    for (const row of returns) assert.deepEqual([row.kind, row.merchant, row.issuerCategory], ['purchase', row.description, null]);
    assert.deepEqual(payload.rows.filter((row) => / ACH Payment$/.test(row.description)).map((row) => row.kind), Array(6).fill('payment'));
    assert.deepEqual(payload.rows.filter((row) => !CUT.test(row.description) && !/ ACH Payment$/.test(row.description))
      .map((row) => row.kind).sort(), ['fee', 'interest', ...Array(7).fill('purchase'), 'refund']);

    const rows = payload.rows.map((row) => stored(row.transactionDate, row.description, row.amountMinor, row.kind, { merchant: row.merchant ?? undefined }));
    const read = readCardSpendingRows(rows);
    assert.deepEqual(read.filter((row) => CUT.test(row.description)).map((row) => row.kind), Array(6).fill('payment'));
    read.forEach((row, index) => assert.equal(row === rows[index], !CUT.test(row.description), row.description));

    // The summary without the returns, but for the payments: each return counts against the payment it reverses.
    const after = summarizeCardSpending(read);
    const without = summarizeCardSpending(rows.filter((row) => !CUT.test(row.description)));
    assert.deepEqual({ ...after, totals: [] }, { ...without, totals: [] });
    const { paymentsMinor, paymentCount, ...spending } = after.totals[0];
    const { paymentsMinor: _paid, paymentCount: _payments, ...spendingWithout } = without.totals[0];
    assert.deepEqual(spending, spendingWithout);
    assert.deepEqual([paymentsMinor, paymentCount], [0, 12]);
    assert.equal(spending.spendingMinor, 3 * (1_599 + 6_250) + 8_000 + 2_900 + 1_234 - 1_000);
    // As stored, the returns were spending and their payments stood unanswered.
    const before = summarizeCardSpending(rows).totals[0];
    assert.equal(before.spendingMinor - spending.spendingMinor, 3 * (150_000 + 220_000));
    assert.equal(before.paymentsMinor, -3 * (150_000 + 220_000));

    // Stored as purchases, each was a monthly charge of its own, three charges each, as the overview listed them.
    const today = '2026-07-31';
    const window = (list: readonly CardTransaction[]) => cardSpendingWindow(
      classifyCardSpending(list, { currency: 'USD', through: today, today }), { from: '2026-05-01', to: today });
    const cutLines = (list: readonly CardTransaction[]) => window(list).recurring.filter((line) => CUT.test(line.name))
      .map((line) => [line.name, line.count]).sort();
    assert.deepEqual(cutLines(rows), [[MOBILE, 3], [ONLINE, 3]]);
    assert.deepEqual(cutLines(read), []);
    assert.equal(window(read).spendingMinor, spending.spendingMinor);
    const recurring = (list: readonly CardTransaction[]) => findRecurringCharges(list, today).map((item) => item.merchant);
    assert.deepEqual(recurring(rows).filter((name) => CUT.test(name)).sort(), [MOBILE, ONLINE]);
    assert.deepEqual(recurring(read).filter((name) => CUT.test(name)), []);
    assert.ok(recurring(read).includes('SAMPLE STREAMING SERVICE'));

    const input = { today: '2026-08-05', currency: 'USD', completeMonths: new Set(['2026-05', '2026-06', '2026-07']) };
    const months = (list: readonly CardTransaction[]) => new Map(forecastCardSpending(list, input).months.map((month) => [month.month, month.spendingMinor]));
    const byMonth = new Map(after.byMonth.map((month) => [month.month, month.spendingMinor]));
    for (const month of ['2026-05', '2026-06', '2026-07']) {
      assert.equal(months(read).get(month), byMonth.get(month), month);
      assert.equal((months(rows).get(month) ?? 0) - (months(read).get(month) ?? 0), 150_000 + 220_000, month);
    }
    assert.deepEqual(cardSpendingPatterns(read, input).bills.items.filter((bill) => CUT.test(bill.merchant)), []);
  });
});
