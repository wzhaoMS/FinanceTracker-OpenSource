import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BILT_HOUSING_CATEGORY } from './cardImportTool/biltCsv.js';
import { convertCardExport } from './cardImportTool/convert.js';
import { buildCardCategoryInference } from './cardCategoryInference.js';
import { CARD_CATEGORY_PARKING_CHARGES as PARKING } from './cardCategoryNames.js';
import { computeCardInsights } from './cardInsights.js';
import {
  cardGivenBackCharge, cardGivenBackText, classifyCardKind, hasCardFeeWord, isReturnedCardPaymentCharge, namesCardFee, type KindInput,
} from './cardKinds.js';
import { buildCardSpendingAccounting } from './cardSpendingExclusions.js';
import {
  CARD_UNCATEGORIZED,
  effectiveCardCategory,
  effectiveCardKind,
  readCardSpendingRow,
  readCardSpendingRows,
  summarizeCardSpending,
  toCardTransactionView,
} from './cardSpending.js';
import type { CardTransaction, CardTransactionKind } from './types.js';

// A fee whose words have a payment word but no fees category ("NSF PAYMENT FEE", "RETURNED ONLINE PAYMENT FEE"), and the
// credit that gives such a fee back: a card fee and its reversal, never a card payment, wherever Spending counts.
// Synthetic rows only: made-up merchants, amounts, dates and card ids; the fee and payment wording is issuer wording.

const FEES = 'Fees & Adjustments-Fees & Adjustments';
/** Where one issuer files its card payments: the category is never a fee word. */
const ISSUER_PAYMENTS = 'Fees & Adjustments-Payments';
const GROCERIES = 'Merchandise & Supplies-Groceries';
const UTILITIES = 'Business Services-Utilities';

/** A stored row, with the kind it was stored with. */
function stored(transactionDate: string, description: string, amountMinor: number, kind: CardTransactionKind, patch: Partial<CardTransaction> = {}): CardTransaction {
  return {
    id: `${transactionDate}:${description}:${amountMinor}`, cardAccountId: 'card-a', source: 'test-sync', transactionDate,
    status: 'posted', amountMinor, currency: 'USD', kind, description, createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z', ...patch,
  };
}

/**
 * Stored rows as an enriched answer files them: read as Spending reads them (`readCardSpendingRows`), then given the
 * category the household's inference infers where a row has none of its own.
 */
function enriched(rows: readonly CardTransaction[]): Array<CardTransaction & { inferredCategory: string | null }> {
  const read = readCardSpendingRows(rows);
  const model = buildCardCategoryInference(read);
  return read.map((row) => ({ ...row, inferredCategory: model.infer(row)?.category ?? null }));
}

describe('a fee named beside payment wording', () => {
  it('is named by FEE or FEES, in a row\'s description or its merchant, each read on its own; never by CHARGE or the category', () => {
    for (const text of ['NSF PAYMENT FEE', 'Returned Online Payment Fee', 'RETURNED PAYMENT FEES', 'FEE - RETURNED PAYMENT', 'PAYMENT FEE REVERSAL']) {
      assert.equal(hasCardFeeWord(text), true, text);
    }
    for (const text of ['ONLINE PAYMENT - THANK YOU', 'PAYMENT RECEIVED - CHARGE ACCOUNT', 'RETURNED PAYMENT CHARGE', 'NORTHWIND COFFEE',
      'SAMPLE FEED STORE', 'COFFEES']) {
      assert.equal(hasCardFeeWord(text), false, text);
    }
    assert.equal(namesCardFee({ description: 'SAMPLE BANK', merchant: 'Nsf payment fee' }), true);
    assert.equal(namesCardFee({ description: 'NSF PAYMENT FEE', merchant: null }), true);
    const filedUnderFees = { description: 'AUTOPAY PAYMENT - THANK YOU', merchant: null, issuerCategory: ISSUER_PAYMENTS };
    assert.equal(namesCardFee(filedUnderFees), false);
  });

  it('is converted as a fee on a charge and as its give-back on a credit (holdr-card-import 1.0.3)', () => {
    const kind = (amountMinor: number, description: string, extra: Partial<KindInput> = {}) => classifyCardKind({ amountMinor, description, ...extra });
    // A charge whose returned-payment wording names a fee: the issuer's fee for a payment returned unpaid. 1.0.2 wrote each
    // as a card payment, which left it out of spending.
    for (const text of ['NSF PAYMENT FEE', 'RETURNED ONLINE PAYMENT FEE', 'RETURNED ACH PAYMENT FEE', 'PAYMENT RETURNED FEE', 'REVERSED AUTOPAY FEES',
      'Nsf Payment Fee']) {
      assert.equal(kind(2_700, text), 'fee', text);
    }
    // Fees that already were: by their wording, their issuer's fees category or their type.
    assert.deepEqual([kind(2_900, 'RETURNED PAYMENT FEE'), kind(2_700, 'NSF PAYMENT FEE', { issuerCategory: FEES }),
      kind(2_700, 'NSF PAYMENT FEE', { typeHint: 'FEE' }), kind(3_500, 'LATE PAYMENT FEE')], ['fee', 'fee', 'fee', 'fee']);
    // A credit worded as a payment, or typed as one, that names a fee gives the fee back, and takes the kind its own charge
    // gets. 1.0.2 wrote each as a card payment, so it never offset its fee. The card's own fee's give-back is an
    // adjustment, under a fees category or not.
    for (const text of ['RETURNED PAYMENT FEE REVERSAL', 'NSF PAYMENT FEE REFUND', 'RETURNED ONLINE PAYMENT FEE WAIVED', 'ONLINE PAYMENT LATE FEE CREDIT']) {
      assert.equal(kind(-2_700, text), 'adjustment', text);
      assert.equal(kind(-2_700, text, { issuerCategory: FEES }), 'adjustment', `${text} under fees`);
    }
    assert.equal(kind(-2_700, 'LATE FEE REVERSAL', { typeHint: 'PAYMENT' }), 'adjustment');
    // A merchant's fee for being paid online is a purchase, so its give-back is a refund, whatever its give-back word:
    // never an adjustment, which Spending's card costs read as a card fee given back. Unless the issuer marks the fee as
    // its own, by its fees category or the OFX type of the credit: then it is the card's, and its give-back an adjustment.
    for (const text of ['SAMPLE UTILITY ONLINE PAYMENT FEE REFUND', 'SAMPLE UTILITY ONLINE PAYMENT FEE REVERSAL', 'ONLINE PAYMENT FEE CREDIT',
      'SAMPLE PARKING ONLINE PAYMENT FEE', 'Sample parking online payment fee waived']) {
      assert.equal(kind(-500, text), 'refund', text);
      assert.equal(kind(-500, text, { typeHint: 'PAYMENT' }), 'refund', `${text} typed as a payment`);
      assert.equal(kind(-500, text, { issuerCategory: FEES }), 'adjustment', `${text} under fees`);
      assert.equal(kind(-500, text, { typeHint: 'SRVCHG' }), 'adjustment', `${text} typed as a service charge`);
    }
    // A service fee is the card's by the charge words every converter version reads (a "SERVICE FEE" charge is a fee): its
    // give-back is an adjustment, as its charge is a fee. Which service fees are merchants' changes on the charge side too.
    assert.deepEqual([kind(500, 'ONLINE PAYMENT SERVICE FEE'), kind(-500, 'ONLINE PAYMENT SERVICE FEE REFUND')], ['fee', 'adjustment']);
    // Each text on its own, as every wording rule reads them.
    assert.deepEqual([kind(2_700, 'SAMPLE BANK', { evidence: 'Nsf payment fee' }), kind(2_700, 'NSF PAYMENT', { evidence: 'Sample fee' }),
      kind(-2_700, 'SAMPLE BANK', { evidence: 'Returned payment fee reversal' }), kind(-500, 'SAMPLE BANK', { evidence: 'Online payment fee refund' })],
    ['fee', 'fee', 'adjustment', 'refund']);
    // A payment names no fee: a payment, the payment returned, a payment its issuer files under fees and adjustments and
    // a payment by its type are card payments, as before.
    assert.deepEqual([kind(-150_000, 'ONLINE ACH PAYMENT - THANK YOU'), kind(150_000, 'RETURNED ONLINE ACH PAYMENT'),
      kind(150_000, 'NSF PAYMENT'), kind(150_000, 'PAYMENT REVERSAL'), kind(-80_000, 'AUTOPAY PAYMENT - THANK YOU', { issuerCategory: ISSUER_PAYMENTS }),
      kind(-60_000, 'SAMPLE BANK', { typeHint: 'PAYMENT' })], ['payment', 'payment', 'payment', 'payment', 'payment', 'payment']);
    // Payment wording on a charge that says nothing of a return is read as if it were not there, fee word or not: a
    // biller's own fee for being paid by card is a purchase, as 1.0.2 read it.
    assert.equal(kind(500, 'SAMPLE UTILITY ONLINE PAYMENT FEE'), 'purchase');
  });

  it('is read as the import classifier kinds it now, however it was stored; a card payment never names one', () => {
    // Rows earlier holdr-card-import versions stored as card payments: 1.0.2 a fee for a returned payment, and the credit
    // giving one back; tools before it a biller's own fee for being paid online too, for its payment words.
    for (const [description, amountMinor, read] of [
      ['NSF PAYMENT FEE', 2_700, 'fee'], ['RETURNED ONLINE PAYMENT FEE', 3_500, 'fee'], ['SAMPLE UTILITY ONLINE PAYMENT FEE', 500, 'purchase'],
      ['RETURNED PAYMENT FEE REVERSAL', -2_900, 'adjustment'], ['NSF PAYMENT FEE REFUND', -2_700, 'adjustment'],
      ['SAMPLE UTILITY ONLINE PAYMENT FEE REFUND', -500, 'refund'], ['ONLINE PAYMENT SERVICE FEE REFUND', -500, 'adjustment'],
    ] as const) {
      assert.equal(effectiveCardKind(stored('2026-09-15', description, amountMinor, 'payment')), read, description);
      assert.equal(read, classifyCardKind({ amountMinor, description }), description);
    }
    // A stored service fee pair keeps its charge's stored kind: every converter stored a "SERVICE FEE" charge as a fee, and
    // its give-back, stored as a card payment, reads as the adjustment that offsets it.
    assert.deepEqual(readCardSpendingRows([stored('2026-09-10', 'ONLINE PAYMENT SERVICE FEE', 500, 'fee'),
      stored('2026-09-17', 'ONLINE PAYMENT SERVICE FEE REFUND', -500, 'payment')]).map((row) => row.kind), ['fee', 'adjustment']);
    assert.equal(effectiveCardKind(stored('2026-09-15', 'SAMPLE BANK', 2_700, 'payment', { merchant: 'Nsf payment fee' })), 'fee');
    // With its issuer's category, as the classifier reads it: a biller's fee its issuer files under fees is a fee.
    assert.equal(effectiveCardKind(stored('2026-09-15', 'SAMPLE UTILITY ONLINE PAYMENT FEE', 500, 'payment', { issuerCategory: FEES })), 'fee');
    // Card payments, a payment returned and a Bilt housing payment name no fee, whatever their category: they stay card
    // payments, as does a payment of nothing. CHARGE is no fee word.
    for (const [description, amountMinor, patch] of [
      ['ONLINE ACH PAYMENT - THANK YOU', -150_000, {}], ['AUTOPAY PAYMENT - THANK YOU', -80_000, { issuerCategory: ISSUER_PAYMENTS }],
      ['PAYMENT RECEIVED - CHARGE ACCOUNT', -60_000, {}], ['RETURNED ONLINE ACH PAYMENT', 150_000, {}],
      ['Bilt Housing Payment', -84_500, { issuerCategory: BILT_HOUSING_CATEGORY }], ['NSF PAYMENT FEE', 0, {}],
    ] as const) {
      assert.equal(effectiveCardKind(stored('2026-09-15', description, amountMinor, 'payment', patch)), 'payment', description);
    }
    // The owner's own category comes first: the row counts as stored.
    assert.equal(effectiveCardKind(stored('2026-09-15', 'NSF PAYMENT FEE', 2_700, 'payment', { userCategory: 'Sample bank charges' })), 'payment');
    // A row stored under any other kind is read as before.
    for (const [description, amountMinor, kind] of [
      ['NSF PAYMENT FEE', 2_700, 'fee'], ['SAMPLE UTILITY ONLINE PAYMENT FEE', 500, 'purchase'], ['RETURNED PAYMENT FEE REVERSAL', -2_900, 'adjustment'],
      ['NSF PAYMENT FEE', 2_700, 'other'],
    ] as const) {
      assert.equal(effectiveCardKind(stored('2026-09-15', description, amountMinor, kind)), kind, `${description} ${kind}`);
    }
    // Read, never written: the stored row is untouched, and a row read as its own kind is that very row.
    const row = stored('2026-09-14', 'NSF PAYMENT FEE', 2_700, 'payment');
    assert.deepEqual(readCardSpendingRow(row), { ...row, kind: 'fee' });
    assert.equal(row.kind, 'payment');
    const payment = stored('2026-09-05', 'ONLINE ACH PAYMENT - THANK YOU', -150_000, 'payment');
    assert.equal(readCardSpendingRow(payment), payment);
    // Its view says the kind it is read as, and that it is spending. It is no payment taken back either.
    const view = toCardTransactionView(row);
    assert.deepEqual([view.kind, view.role, view.amountMinor], ['fee', 'spending', 2_700]);
    assert.equal(isReturnedCardPaymentCharge(row), false);
  });
});

describe('payment-worded fees through the spending reads, from the import classifier', () => {
  // Transaction date, description, amount, the issuer's category, and the kind holdr-card-import 1.0.2 wrote.
  const ROWS: ReadonlyArray<readonly [string, string, number, string | null, CardTransactionKind]> = [
    ['2026-09-02', 'NORTHWIND GROCERY', 6_250, GROCERIES, 'purchase'],
    ['2026-09-05', 'ONLINE ACH PAYMENT - THANK YOU', -150_000, null, 'payment'],
    ['2026-09-12', 'RETURNED ONLINE ACH PAYMENT', 150_000, null, 'payment'],
    ['2026-09-12', 'RETURNED ONLINE PAYMENT FEE', 3_500, null, 'payment'],
    ['2026-09-14', 'NSF PAYMENT FEE', 2_700, null, 'payment'],
    ['2026-09-15', 'RETURNED PAYMENT FEE', 2_900, FEES, 'fee'],
    ['2026-09-16', 'RETURNED ACH PAYMENT FEE', 2_500, null, 'payment'],
    ['2026-09-18', 'CONTOSO OUTFITTERS', 9_900, null, 'purchase'],
    ['2026-09-20', 'RETURNED ONLINE PAYMENT FEE REVERSAL', -3_500, null, 'payment'],
    ['2026-09-20', 'INTEREST CHARGE ON PURCHASES', 1_234, null, 'interest'],
    ['2026-09-21', 'LATE FEE', 4_000, null, 'fee'],
    ['2026-09-22', 'RETURNED PAYMENT FEE WAIVED', -2_900, FEES, 'payment'],
    ['2026-09-25', 'CONTOSO OUTFITTERS', -9_900, null, 'refund'],
    ['2026-09-28', 'AUTOPAY PAYMENT - THANK YOU', -80_000, ISSUER_PAYMENTS, 'payment'],
  ];
  const patchOf = (category: string | null): Partial<CardTransaction> => (category === null ? {} : { issuerCategory: category });
  /** As 1.0.2 stored them. */
  const before = ROWS.map(([date, description, amountMinor, category, kind]) => stored(date, description, amountMinor, kind, patchOf(category)));
  /** As 1.0.3 converts them: kinded by the import classifier from their words and their issuer's category. */
  const converted = ROWS.map(([date, description, amountMinor, category]) => stored(date, description, amountMinor,
    classifyCardKind({ amountMinor, description, issuerCategory: category }), patchOf(category)));
  const read = readCardSpendingRows(before);
  const givenBack = new Set(['RETURNED ONLINE PAYMENT FEE REVERSAL', 'RETURNED PAYMENT FEE WAIVED']);
  const feesWordedAsPayments = new Set(['RETURNED ONLINE PAYMENT FEE', 'NSF PAYMENT FEE', 'RETURNED ACH PAYMENT FEE']);

  it('reads the rows 1.0.2 stored as card payments as 1.0.3 converts them, and every other row as stored', () => {
    assert.deepEqual(converted.map((row) => row.kind), ['purchase', 'payment', 'payment', 'fee', 'fee', 'fee', 'fee', 'purchase', 'adjustment',
      'interest', 'fee', 'adjustment', 'refund', 'payment']);
    assert.deepEqual(read, converted);
    assert.deepEqual(readCardSpendingRows(converted), converted);
    read.forEach((row, index) => assert.equal(row === before[index], !givenBack.has(row.description) && !feesWordedAsPayments.has(row.description),
      row.description));
  });

  it('counts each fee as a fee and nets each give-back against its fee; payments, purchases, refunds and interest are as they were', () => {
    const after = summarizeCardSpending(read);
    assert.deepEqual(after, summarizeCardSpending(converted));
    assert.deepEqual(after.totals, [{
      currency: 'USD', spendingMinor: 6_250 + 3_500 + 2_700 + 2_900 + 2_500 + 9_900 - 3_500 + 1_234 + 4_000 - 2_900 - 9_900,
      chargesMinor: 6_250 + 3_500 + 2_700 + 2_900 + 2_500 + 9_900 + 1_234 + 4_000, creditsMinor: -3_500 - 2_900 - 9_900, count: 11,
      paymentsMinor: -150_000 + 150_000 - 80_000, paymentCount: 3, otherMinor: 0, otherCount: 0,
    }]);
    // A fee and the credit that gives it back net to nothing.
    assert.deepEqual(after.byCategory.find((item) => item.category === FEES), {
      category: FEES, currency: 'USD', spendingMinor: 0, chargesMinor: 2_900, creditsMinor: -2_900, count: 2,
    });
    // As stored, the fees worded as payments were no spending, and no give-back offset its fee.
    const asStored = summarizeCardSpending(before);
    assert.deepEqual(asStored.byCategory.find((item) => item.category === FEES), {
      category: FEES, currency: 'USD', spendingMinor: 2_900, chargesMinor: 2_900, creditsMinor: 0, count: 1,
    });
    assert.equal(after.totals[0].spendingMinor - asStored.totals[0].spendingMinor, 2_700 + 2_500 - 2_900);
    assert.deepEqual([asStored.totals[0].paymentsMinor, asStored.totals[0].paymentCount], [-80_000 + 3_500 + 2_700 + 2_500 - 3_500 - 2_900, 8]);
  });

  it('keeps every posted row in the card\'s activity: only what counts as a card payment changes', () => {
    const [asStored] = buildCardSpendingAccounting(before);
    const [book] = buildCardSpendingAccounting(read);
    assert.deepEqual(book.activity, asStored.activity);
    assert.equal(book.activity.netMinor, before.reduce((sum, row) => sum + row.amountMinor, 0));
    assert.deepEqual(book.transfers, { netMinor: -80_000, chargesMinor: 150_000, creditsMinor: -230_000, count: 3 });
    assert.equal(asStored.transfers.count, 8);
    assert.equal(book.spending.netMinor, summarizeCardSpending(read).totals[0].spendingMinor);
  });

  it('counts the fees in the card\'s costs, and none that was given back', () => {
    const costs = (rows: readonly CardTransaction[]) => computeCardInsights(rows, { month: '2026-09', today: '2026-09-30', currency: 'USD' }).costs.period;
    assert.deepEqual(costs(read), { feesMinor: 2_700 + 2_500 + 4_000, interestMinor: 1_234, foreignFeesMinor: 0, reversalsMinor: 0 });
    assert.deepEqual(costs(before), { feesMinor: 2_900 + 4_000, interestMinor: 1_234, foreignFeesMinor: 0, reversalsMinor: 0 });
  });

  it('files every fee, the interest and each give-back under the card\'s fees on the enriched basis, where they net', () => {
    // The default basis: a row with no category of its own takes the household's inferred one. The fees and the interest
    // by their kinds, each give-back as the fee it gives back, whether it was stored as a payment or converted so.
    for (const rows of [before, converted]) {
      const summary = summarizeCardSpending(enriched(rows));
      assert.deepEqual(summary.byCategory.map((item) => [item.category, item.spendingMinor, item.chargesMinor, item.creditsMinor, item.count]), [
        [FEES, 3_500 + 2_700 + 2_900 + 2_500 - 3_500 + 1_234 + 4_000 - 2_900, 3_500 + 2_700 + 2_900 + 2_500 + 1_234 + 4_000, -3_500 - 2_900, 8],
        [GROCERIES, 6_250, 6_250, 0, 1],
        [CARD_UNCATEGORIZED, 0, 9_900, -9_900, 2],
      ]);
      assert.equal(summary.byCategory.reduce((sum, item) => sum + item.spendingMinor, 0), summary.totals[0].spendingMinor);
    }
  });
});

describe('a fee and its give-back with no category, on the enriched basis', () => {
  // Only the two posted rows of each pair: no owner or issuer category, and no history with one. Each as a producer stored
  // it: as card payments (holdr-card-import 1.0.2 a fee for a returned payment and its credit; tools before it a biller's
  // fee for being paid online and its credit too), or kinded by the import classifier, as 1.0.3 converts it.
  const PAIRS: ReadonlyArray<{
    pair: string;
    rows: readonly [readonly [string, string, number], readonly [string, string, number]];
    read: readonly [CardTransactionKind, CardTransactionKind];
    category: string;
    asPayments: boolean;
  }> = [
    // A card's fee or interest and its credit: under the card's fees. The classifier makes a credit in the fee's own words,
    // with none that gives it back, a refund.
    { pair: 'a fee for a returned payment', rows: [['2026-09-14', 'NSF PAYMENT FEE', 2_700], ['2026-09-20', 'NSF PAYMENT FEE REFUND', -2_700]],
      read: ['fee', 'adjustment'], category: FEES, asPayments: true },
    // REVERSED beside the payment word is the fee's own word, not the one that gives it back.
    { pair: 'a fee for a reversed payment', rows: [['2026-09-15', 'REVERSED PAYMENT FEE', 2_500], ['2026-09-22', 'REVERSED PAYMENT FEE REFUND', -2_500]],
      read: ['fee', 'adjustment'], category: FEES, asPayments: true },
    { pair: 'interest', rows: [['2026-09-20', 'INTEREST CHARGE ON PURCHASES', 1_234], ['2026-09-24', 'INTEREST CHARGE ON PURCHASES REVERSAL', -1_234]],
      read: ['interest', 'adjustment'], category: FEES, asPayments: false },
    { pair: 'a late payment fee', rows: [['2026-09-21', 'LATE PAYMENT FEE', 3_500], ['2026-09-26', 'LATE PAYMENT FEE', -3_500]],
      read: ['fee', 'refund'], category: FEES, asPayments: false },
    // A card fee the classifier knows with no FEE word.
    { pair: 'an annual membership', rows: [['2026-09-01', 'ANNUAL MEMBERSHIP', 9_500], ['2026-09-08', 'ANNUAL MEMBERSHIP REVERSAL', -9_500]],
      read: ['fee', 'refund'], category: FEES, asPayments: false },
    // A merchant's fee and its refund: with the merchant, never under the card's fees. A credit worded as a payment gives
    // back a purchase, so it is a refund; one with only main's reversal wording ("SAMPLE PARKING FEE REFUND") keeps the
    // adjustment every converter wrote for it, which a follow-up changes, stored rows included (ROOT O133).
    { pair: 'a parking operator\'s fee', rows: [['2026-09-10', 'SAMPLE PARKING FEE', 2_700], ['2026-09-17', 'SAMPLE PARKING FEE REFUND', -2_700]],
      read: ['purchase', 'adjustment'], category: PARKING, asPayments: false },
    { pair: 'a parking operator\'s fee for being paid online',
      rows: [['2026-09-10', 'SAMPLE CITY PARKING ONLINE PAYMENT FEE', 500], ['2026-09-17', 'SAMPLE CITY PARKING ONLINE PAYMENT FEE REFUND', -500]],
      read: ['purchase', 'refund'], category: PARKING, asPayments: true },
    { pair: 'a biller\'s fee for being paid online, nothing known of the biller',
      rows: [['2026-09-13', 'SAMPLE UTILITY ONLINE PAYMENT FEE', 500], ['2026-09-19', 'SAMPLE UTILITY ONLINE PAYMENT FEE REFUND', -500]],
      read: ['purchase', 'refund'], category: CARD_UNCATEGORIZED, asPayments: true },
    // REVERSAL after the fee's name gives it back, though the fee's own words have a payment word.
    { pair: 'a biller\'s fee for being paid online, reversed',
      rows: [['2026-09-13', 'SAMPLE UTILITY ONLINE PAYMENT FEE', 500], ['2026-09-19', 'SAMPLE UTILITY ONLINE PAYMENT FEE REVERSAL', -500]],
      read: ['purchase', 'refund'], category: CARD_UNCATEGORIZED, asPayments: true },
  ];
  const layers = (rows: readonly (readonly [string, string, number])[], asPayments: boolean): Array<[string, CardTransaction[]]> => {
    const kinded: Array<[string, CardTransaction[]]> = [['as the import classifier kinds it (1.0.3)', rows.map(([date, description, amountMinor]) =>
      stored(date, description, amountMinor, classifyCardKind({ amountMinor, description })))]];
    if (asPayments) kinded.push(['stored as card payments', rows.map(([date, description, amountMinor]) => stored(date, description, amountMinor, 'payment'))]);
    return kinded;
  };

  it('files the charge and its credit in one category, where they net, and a filter by it keeps the credit with its charge', () => {
    for (const { pair, rows: texts, read, category, asPayments } of PAIRS) {
      const [charge, credit] = texts.map(([, , amountMinor]) => amountMinor);
      for (const [layer, rows] of layers(texts, asPayments)) {
        const label = `${pair}, ${layer}`;
        const shown = enriched(rows);
        assert.deepEqual(shown.map((row) => [row.kind, effectiveCardCategory(row)]), [[read[0], category], [read[1], category]], label);
        assert.deepEqual(summarizeCardSpending(shown).byCategory, [
          { category, currency: 'USD', spendingMinor: 0, chargesMinor: charge, creditsMinor: credit, count: 2 },
        ], label);
        const filed = summarizeCardSpending(shown.filter((row) => effectiveCardCategory(row) === category)).totals;
        assert.deepEqual(filed.map((total) => [total.spendingMinor, total.chargesMinor, total.creditsMinor, total.count]), [[0, charge, credit, 2]], label);
        // On the original basis neither has a category: both uncategorized, where they net too.
        assert.deepEqual(summarizeCardSpending(readCardSpendingRows(rows)).byCategory.map((item) => [item.category, item.spendingMinor, item.count]),
          [[CARD_UNCATEGORIZED, 0, 2]], label);
      }
    }
  });

  it('files a merchant\'s fee and its refund where the merchant\'s history files its charges', () => {
    // Another card's issuer files the merchant's fee under a category of its own: the fee and its refund go there too,
    // however stored. A merchant's name may lead with a word that gives a fee back elsewhere (CREDIT): it stays its name.
    for (const [charge, credit, category, asPayments, creditKind] of [
      ['SAMPLE UTILITY ONLINE PAYMENT FEE', 'SAMPLE UTILITY ONLINE PAYMENT FEE REFUND', UTILITIES, true, 'refund'],
      ['CREDIT SAMPLE STORE FEE', 'CREDIT SAMPLE STORE FEE REFUND', 'Sample stores', false, 'adjustment'],
    ] as const) {
      const history = ['2026-07-13', '2026-08-13'].map((date) => stored(date, charge, 500, 'purchase', { cardAccountId: 'card-b', issuerCategory: category }));
      for (const [layer, rows] of layers([['2026-09-13', charge, 500], ['2026-09-19', credit, -500]], asPayments)) {
        const shown = enriched([...history, ...rows]).slice(history.length);
        assert.deepEqual(shown.map((row) => [row.kind, row.inferredCategory]), [['purchase', category], [creditKind, category]], `${credit}, ${layer}`);
      }
    }
  });

  it('reads the charge a credit gives back from the credit\'s own words, less the ones that give it back', () => {
    for (const [text, charge] of [
      ['NSF PAYMENT FEE REFUND', 'NSF PAYMENT FEE'], ['RETURNED PAYMENT FEE REVERSAL', 'RETURNED PAYMENT FEE'],
      ['Returned online payment fee waived', 'Returned online payment fee'], ['REVERSAL OF LATE FEE', 'LATE FEE'],
      ['CREDIT FOR ANNUAL FEE', 'ANNUAL FEE'], ['CREDIT - ANNUAL FEE', 'ANNUAL FEE'], ['ADJ: LATE FEE', 'LATE FEE'],
      ['LATE FEE - REVERSAL', 'LATE FEE'], ['LATE PAYMENT FEE', 'LATE PAYMENT FEE'],
      ['SAMPLE UTILITY ONLINE PAYMENT FEE REVERSAL', 'SAMPLE UTILITY ONLINE PAYMENT FEE'],
      // Words before the fee's name are its own, but for a give-back word leading the text before OF, FOR or a separator:
      // a return word in the fee's name, a merchant's name.
      ['PAYMENT REVERSAL FEE REFUND', 'PAYMENT REVERSAL FEE'], ['REVERSED PAYMENT FEE REFUND', 'REVERSED PAYMENT FEE'],
      ['REVERSED AUTOPAY FEES CREDIT', 'REVERSED AUTOPAY FEES'], ['CREDIT SAMPLE STORE FEE REFUND', 'CREDIT SAMPLE STORE FEE'],
      // REVERSAL or REVERSED beside a payment word names the returned payment the fee is for, after the fee's name too.
      ['FEE FOR REVERSED PAYMENT REFUND', 'FEE FOR REVERSED PAYMENT'], ['FEE - PAYMENT REVERSAL CREDIT', 'FEE - PAYMENT REVERSAL'],
      ['INTEREST CHARGE ON PURCHASES REVERSAL', 'INTEREST CHARGE ON PURCHASES'], ['FINANCE CHARGE ADJ', 'FINANCE CHARGE'],
      ['ANNUAL MEMBERSHIP REVERSAL', 'ANNUAL MEMBERSHIP'], ['SAMPLE PARKING FEE REFUND', 'SAMPLE PARKING FEE'],
    ] as const) {
      assert.equal(cardGivenBackText(text), charge, text);
    }
    // No fee or interest word, so no fee or interest given back: COFFEE and FEED hold no FEE word.
    for (const text of ['SAMPLE DIGITAL ENTERTAINMENT CREDIT', 'NORTHWIND COFFEE CREDIT', 'SAMPLE FEED STORE CREDIT', 'CONTOSO OUTFITTERS']) {
      assert.equal(cardGivenBackText(text), null, text);
    }
    // Kinded as the import classifier kinds such a charge, from either text: a card's fee or interest, or a merchant's charge.
    assert.deepEqual(cardGivenBackCharge({ description: 'SAMPLE BANK', merchant: 'Late fee reversal' }),
      { kind: 'fee', description: 'SAMPLE BANK', merchant: 'Late fee' });
    assert.deepEqual(cardGivenBackCharge({ description: 'INTEREST CHARGE ON PURCHASES REVERSAL' }),
      { kind: 'interest', description: 'INTEREST CHARGE ON PURCHASES', merchant: null });
    assert.deepEqual(cardGivenBackCharge({ description: 'SAMPLE PARKING FEE REFUND', merchant: null }),
      { kind: 'purchase', description: 'SAMPLE PARKING FEE', merchant: null });
    assert.equal(cardGivenBackCharge({ description: 'SAMPLE DIGITAL ENTERTAINMENT CREDIT', merchant: 'Sample streaming' }), null);
  });
});

describe('a payment-worded fee and its give-back with a category of their own', () => {
  // Only these two posted rows, and no history: the categories each test gives them are the only ones.
  const pairs: Array<[string, CardTransaction[]]> = [
    ['as holdr-card-import 1.0.2 stored them', [
      stored('2026-09-14', 'NSF PAYMENT FEE', 2_700, 'payment'), stored('2026-09-20', 'NSF PAYMENT FEE REFUND', -2_700, 'payment'),
    ]],
    ['as holdr-card-import 1.0.3 converts them', ([['2026-09-14', 'NSF PAYMENT FEE', 2_700], ['2026-09-20', 'NSF PAYMENT FEE REFUND', -2_700]] as const)
      .map(([date, description, amountMinor]) => stored(date, description, amountMinor, classifyCardKind({ amountMinor, description })))],
  ];

  it('leaves a category of the issuer\'s own, or the owner\'s, where it is', () => {
    for (const [label, rows] of pairs) {
      // The issuer's category stands on both: no rule files over it.
      const issued = enriched(rows.map((row) => ({ ...row, issuerCategory: 'Sample issuer fees' })));
      assert.deepEqual(issued.map((row) => [row.inferredCategory, effectiveCardCategory(row)]),
        [[null, 'Sample issuer fees'], [null, 'Sample issuer fees']], label);
      // The owner's own category comes first, as it does for the kind.
      const owned = enriched(rows.map((row) => ({ ...row, userCategory: 'Sample bank charges' })));
      assert.deepEqual(owned.map((row) => [row.inferredCategory, effectiveCardCategory(row)]),
        [[null, 'Sample bank charges'], [null, 'Sample bank charges']], label);
    }
  });
});

/** A converted payload's rows as the ledger stores them. */
function storedRows(payload: ReturnType<typeof convertCardExport>['payload'], card: string): CardTransaction[] {
  return payload.rows.map((row, index) => ({
    id: `${card}-${index}`, cardAccountId: card, source: payload.source, transactionDate: row.transactionDate, status: row.status,
    amountMinor: row.amountMinor, currency: payload.currency, kind: row.kind, description: row.description,
    ...(row.issuerCategory === null ? {} : { issuerCategory: row.issuerCategory }),
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  }));
}

describe('payment-worded fees in the converter\'s CSV formats', () => {
  const csv = (lines: readonly string[]) => new Uint8Array(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));

  it('writes the fee as a fee and its give-back as an adjustment, which Spending counts as written', () => {
    // amex-csv: money spent positive. A payment, the payment returned, the issuer's fee for that, and the fee given back.
    const amex = convertCardExport(csv(['Date,Description,Amount', '2026-09-05,ONLINE PAYMENT - THANK YOU,-500.00',
      '2026-09-12,RETURNED PAYMENT,500.00', '2026-09-14,NSF PAYMENT FEE,27.00', '2026-09-20,RETURNED PAYMENT FEE REVERSAL,-27.00']),
    { format: 'amex-csv', status: 'posted', dateOrder: 'ymd' }).payload;
    assert.deepEqual(amex.rows.map((row) => [row.amountMinor, row.kind]), [[-50_000, 'payment'], [50_000, 'payment'], [2_700, 'fee'], [-2_700, 'adjustment']]);
    const rows = storedRows(amex, 'card-c');
    assert.deepEqual(readCardSpendingRows(rows), rows);
    assert.deepEqual(summarizeCardSpending(rows).totals, [{
      currency: 'USD', spendingMinor: 0, chargesMinor: 2_700, creditsMinor: -2_700, count: 2, paymentsMinor: 0, paymentCount: 2, otherMinor: 0, otherCount: 0,
    }]);
  });

  it('proves a Wells Fargo file\'s sign by its card payments alone: a payment-worded fee is none', () => {
    // wf-csv: charges negative, as Wells Fargo writes them. 1.0.2 took the biller's ONLINE PAYMENT FEE, a charge, for a card
    // payment and refused the file: its payment rows disagreed on the sign.
    const wf = convertCardExport(csv(['DATE,DESCRIPTION,AMOUNT', '2026-09-05,ONLINE PAYMENT - THANK YOU,500.00', '2026-09-12,RETURNED PAYMENT,-500.00',
      '2026-09-13,SAMPLE UTILITY ONLINE PAYMENT FEE,-5.00', '2026-09-14,NSF PAYMENT FEE,-27.00', '2026-09-20,RETURNED PAYMENT FEE REVERSAL,27.00']),
    { format: 'wf-csv', status: 'posted', dateOrder: 'ymd' }).payload;
    assert.deepEqual(wf.rows.map((row) => [row.amountMinor, row.kind]),
      [[-50_000, 'payment'], [50_000, 'payment'], [500, 'purchase'], [2_700, 'fee'], [-2_700, 'adjustment']]);
    assert.deepEqual(summarizeCardSpending(readCardSpendingRows(storedRows(wf, 'card-w'))).totals[0],
      { currency: 'USD', spendingMinor: 500, chargesMinor: 500 + 2_700, creditsMinor: -2_700, count: 3, paymentsMinor: 0, paymentCount: 2, otherMinor: 0, otherCount: 0 });
  });
});

describe('payment-worded fees in a Bilt CSV', () => {
  const HEADER = 'Transaction Date,Posted Date,Description,Amount,Card Last 4,Name on Card,Raw Merchant Name';
  /** Account-level rows (no card), as Bilt writes payments, its own fees and its credits. */
  const file = (rows: ReadonlyArray<readonly [string, string, string]>) => new Uint8Array(Buffer.from(
    `${[HEADER, ...rows.map(([date, description, amount]) => `${date},${date},${description},${amount},,,`)].join('\r\n')}\r\n`, 'utf8'));
  const rows = [
    ['2026-09-05', 'Payment', '-500.00'],
    ['2026-09-12', 'Payment returned', '500.00'],
    ['2026-09-13', 'Returned payment fee', '29.00'],
    ['2026-09-14', 'NSF payment fee', '27.00'],
    ['2026-09-20', 'Returned payment fee reversal', '-29.00'],
    ['2026-09-21', 'Late payment fee', '35.00'],
    ['2026-09-25', 'Bilt Housing Payment', '-845.00'],
  ] as const;

  it('takes a row that names a fee for no payment of its layout: its words make it a fee, or the adjustment that gives one back', () => {
    const { payload } = convertCardExport(file(rows), { format: 'bilt-csv', status: 'export', loanPayments: 'not-spending' });
    assert.deepEqual(payload.rows.map((row) => [row.description, row.amountMinor, row.kind, row.issuerCategory]), [
      ['Payment', -50_000, 'payment', null], ['Payment returned', 50_000, 'payment', null], ['Returned payment fee', 2_900, 'fee', null],
      ['NSF payment fee', 2_700, 'fee', null], ['Returned payment fee reversal', -2_900, 'adjustment', null],
      ['Late payment fee', 3_500, 'fee', null], ['Bilt Housing Payment', -84_500, 'payment', BILT_HOUSING_CATEGORY],
    ]);
    // Stored so, every row is read as written, and the fees count: the one given back against its fee.
    const asStored = storedRows(payload, 'card-b');
    assert.deepEqual(readCardSpendingRows(asStored), asStored);
    assert.deepEqual(summarizeCardSpending(asStored).totals, [{
      currency: 'USD', spendingMinor: 2_900 + 2_700 - 2_900 + 3_500, chargesMinor: 2_900 + 2_700 + 3_500, creditsMinor: -2_900, count: 4,
      paymentsMinor: -50_000 + 50_000 - 84_500, paymentCount: 3, otherMinor: 0, otherCount: 0,
    }]);
  });
});
