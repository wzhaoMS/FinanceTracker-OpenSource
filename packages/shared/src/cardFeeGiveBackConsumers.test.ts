import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BENEFITS_CATALOG } from './cardBenefits/catalog.js';
import { benefitProductById } from './cardBenefits/products.js';
import { matchBenefitCredit } from './cardBenefits/report.js';
import { buildCardCategoryInference } from './cardCategoryInference.js';
import { CARD_CATEGORY_FEES_ADJUSTMENTS as FEES, CARD_CATEGORY_PARKING_CHARGES as PARKING } from './cardCategoryNames.js';
import { computeCardInsights, findRecurringCharges } from './cardInsights.js';
import { classifyCardKind } from './cardKinds.js';
import { buildCardSpendingAccounting } from './cardSpendingExclusions.js';
import { readCardSpendingSeries } from './cardSpendingForecast.js';
import { readCardSpendingRows, summarizeCardSpending } from './cardSpending.js';
import type { CardTransaction, CardTransactionKind } from './types.js';

// A fee given back takes the kind its own charge gets (ROOT O133): the card's own fee or interest is given back by an
// adjustment, a card-cost reversal; a merchant's fee is a purchase, and its refund a refund. #355 applies it to the rows
// earlier tools stored as card payments that name a fee, and to the credits 1.0.3 converts so. Every consumer of those
// kinds, with both counterexamples, reading the rows as Spending reads them, from either producer. Synthetic rows only:
// made-up merchants, amounts, dates and card ids; the fee and payment wording is issuer wording.

/** Date, description, amount, and the kind earlier tools stored (a card payment, for a row worded as one). */
type Spec = readonly [string, string, number, CardTransactionKind];

function row(spec: Spec, kind: CardTransactionKind, patch: Partial<CardTransaction> = {}): CardTransaction {
  const [transactionDate, description, amountMinor] = spec;
  return {
    id: `${transactionDate}:${description}:${amountMinor}`, cardAccountId: 'card-a', source: 'test-sync', transactionDate, status: 'posted',
    amountMinor, currency: 'USD', kind, description, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...patch,
  };
}

/** The rows as Spending reads them (`readCardSpendingRows`): as holdr-card-import 1.0.3 converts them, and as earlier tools stored them. */
function layers(specs: readonly Spec[], patch: Partial<CardTransaction> = {}): Array<[string, CardTransaction[]]> {
  return [
    ['as 1.0.3 converts them', readCardSpendingRows(specs.map((spec) => row(spec, classifyCardKind({ amountMinor: spec[2], description: spec[1] }), patch)))],
    ['as earlier tools stored them', readCardSpendingRows(specs.map((spec) => row(spec, spec[3], patch)))],
  ];
}

/** Rows read as Spending reads them, given the household's inferred categories (the enriched basis). */
function enriched(rows: readonly CardTransaction[]): Array<CardTransaction & { inferredCategory: string | null }> {
  const model = buildCardCategoryInference(rows);
  return rows.map((item) => ({ ...item, inferredCategory: model.infer(item)?.category ?? null }));
}

/** As the merchant's refund would read as an adjustment (b0ed3be8): the control each consumer's counterexample bites on. */
const refundsAsAdjustments = <T extends CardTransaction>(rows: readonly T[]): T[] =>
  rows.map((item) => (item.kind === 'refund' ? { ...item, kind: 'adjustment' as const } : item));

const SEPTEMBER = { month: '2026-09', today: '2026-10-05', currency: 'USD' } as const;

/** The reviewer's: a card fee, and a merchant's fee for being paid online of the same amount, refunded. */
const MERCHANT_FEE: Spec[] = [
  ['2026-09-01', 'ANNUAL FEE', 500, 'fee'],
  ['2026-09-10', 'SAMPLE PARKING ONLINE PAYMENT FEE', 500, 'payment'],
  ['2026-09-17', 'SAMPLE PARKING ONLINE PAYMENT FEE REFUND', -500, 'payment'],
];
/** The card's own fee for a returned payment, given back. */
const CARD_FEE: Spec[] = [
  ['2026-09-14', 'NSF PAYMENT FEE', 2_700, 'payment'],
  ['2026-09-20', 'NSF PAYMENT FEE REFUND', -2_700, 'payment'],
];
const groceries = (month: string): Spec[] => ['03', '11', '24'].map((day): Spec => [`${month}-${day}`, 'NORTHWIND GROCERY', 6_250, 'purchase']);

describe('a fee given back, in every consumer of its kind', () => {
  it('is read as the kind its own charge gets, however it was stored, and nothing stored changes', () => {
    for (const [layer, rows] of layers([...MERCHANT_FEE, ...CARD_FEE])) {
      assert.deepEqual(rows.map((item) => [item.description, item.kind]), [
        ['ANNUAL FEE', 'fee'], ['SAMPLE PARKING ONLINE PAYMENT FEE', 'purchase'], ['SAMPLE PARKING ONLINE PAYMENT FEE REFUND', 'refund'],
        ['NSF PAYMENT FEE', 'fee'], ['NSF PAYMENT FEE REFUND', 'adjustment'],
      ], layer);
    }
    // Read, never written: the payment reconciliation, the cash plan and the balance chain read the stored kinds.
    const stored = [...MERCHANT_FEE, ...CARD_FEE].map((spec) => row(spec, spec[3]));
    const before = JSON.stringify(stored);
    readCardSpendingRows(stored);
    assert.equal(JSON.stringify(stored), before);
  });

  it('spending totals and categories: each pair nets, in one category each', () => {
    for (const [layer, rows] of layers([...MERCHANT_FEE, ...CARD_FEE])) {
      assert.deepEqual(summarizeCardSpending(rows).totals.map((total) => [total.spendingMinor, total.chargesMinor, total.creditsMinor, total.count,
        total.paymentsMinor, total.paymentCount]), [[500, 500 + 500 + 2_700, -500 - 2_700, 5, 0, 0]], layer);
      const byCategory = summarizeCardSpending(enriched(rows)).byCategory
        .map((item): [string, number, number] => [item.category, item.spendingMinor, item.count]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      assert.deepEqual(byCategory, [[FEES, 500, 3], [PARKING, 0, 2]], layer);
    }
  });

  it('the accounting: both pairs are spending, no card payment and no asset purchase', () => {
    for (const [layer, rows] of layers([...MERCHANT_FEE, ...CARD_FEE])) {
      const [book] = buildCardSpendingAccounting(rows);
      assert.deepEqual([book.activity.netMinor, book.spending.netMinor, book.transfers.count], [500, 500, 0], layer);
    }
  });

  it('card costs: a merchant\'s refund never cancels a card fee, and a card fee\'s give-back still does', () => {
    const NONE = { interestMinor: 0, foreignFeesMinor: 0, reversalsMinor: 0 };
    const costs = (rows: readonly CardTransaction[]) => computeCardInsights(rows, SEPTEMBER).costs;
    for (const [layer, rows] of layers([...MERCHANT_FEE, ...CARD_FEE])) {
      // The annual fee is the card's cost; the returned-payment fee and its give-back cancel; the merchant's fee and its
      // refund are no card cost.
      assert.deepEqual(costs(rows), { period: { feesMinor: 500, ...NONE }, year: { year: '2026', feesMinor: 500, ...NONE } }, layer);
      // Control: read as an adjustment, the merchant's refund cancelled the unrelated annual fee of its amount.
      assert.deepEqual(costs(refundsAsAdjustments(rows)).period, { feesMinor: 0, ...NONE }, layer);
    }
    // Without a fee of its amount, the merchant's refund is no reversal either.
    for (const [layer, rows] of layers(MERCHANT_FEE.slice(1))) assert.deepEqual(costs(rows).period, { feesMinor: 0, ...NONE }, layer);
    // Two card fees of one amount and one given back: one cost remains.
    for (const [layer, rows] of layers([['2026-09-02', 'ANNUAL FEE', 2_700, 'fee'], ...CARD_FEE])) {
      assert.deepEqual(costs(rows).period, { feesMinor: 2_700, ...NONE }, layer);
    }
  });

  it('large one-offs: neither give-back is set against another merchant\'s large purchase', () => {
    for (const [layer, rows] of layers([...groceries('2026-09'), ['2026-09-05', 'CONTOSO APPLIANCES', 80_000, 'purchase'], ...MERCHANT_FEE, ...CARD_FEE])) {
      const insights = computeCardInsights(rows, SEPTEMBER);
      assert.equal(insights.spendingMinor, 3 * 6_250 + 80_000 + 500, layer);
      assert.deepEqual(insights.largePurchases?.items.map((item) => [item.amountMinor, item.refundedMinor]), [[80_000, 0]], layer);
      assert.equal(insights.largePurchases?.coreMinor, 3 * 6_250 + 500, layer);
    }
  });

  it('movers: a merchant\'s fee and its refund net with the merchant; a card fee and its give-back stay aside', () => {
    // A merchant's refund in the merchant's own words, as most post.
    const refunded: Spec[] = [
      ['2026-09-10', 'SAMPLE CITY PARKING ONLINE PAYMENT FEE', 9_000, 'payment'], ['2026-09-17', 'SAMPLE CITY PARKING ONLINE PAYMENT FEE', -9_000, 'payment'],
    ];
    for (const [layer, rows] of layers([...groceries('2026-08'), ...groceries('2026-09'), ...refunded, ...CARD_FEE])) {
      const shown = enriched(rows);
      assert.deepEqual(shown.filter((item) => item.amountMinor === -9_000).map((item) => [item.kind, item.inferredCategory]), [['refund', PARKING]], layer);
      const insights = computeCardInsights(shown, SEPTEMBER);
      assert.deepEqual([insights.movers, insights.merchantMovers], [[], []], layer);
      // Control: read as an adjustment, the refund left the fee alone among what was bought: parking up by all of it.
      assert.deepEqual(computeCardInsights(refundsAsAdjustments(shown), SEPTEMBER).movers.map((mover) => [mover.category, mover.deltaMinor, mover.share]),
        [[PARKING, 9_000, null]], layer);
    }
  });

  it('duplicates: a merchant\'s refund settles a fee charged twice; a card fee is never a duplicate', () => {
    const specs: Spec[] = [
      ['2026-09-10', 'SAMPLE CITY PARKING ONLINE PAYMENT FEE', 2_500, 'payment'], ['2026-09-11', 'SAMPLE CITY PARKING ONLINE PAYMENT FEE', 2_500, 'payment'],
      ['2026-09-15', 'SAMPLE CITY PARKING ONLINE PAYMENT FEE', -2_500, 'payment'],
      ['2026-09-14', 'NSF PAYMENT FEE', 2_700, 'payment'], ['2026-09-15', 'NSF PAYMENT FEE', 2_700, 'payment'], ['2026-09-20', 'NSF PAYMENT FEE REFUND', -2_700, 'payment'],
    ];
    for (const [layer, rows] of layers(specs)) {
      assert.deepEqual(computeCardInsights(rows, SEPTEMBER).duplicates, [], layer);
      // Control: read as an adjustment, the refund settled nothing.
      assert.deepEqual(computeCardInsights(refundsAsAdjustments(rows), SEPTEMBER).duplicates.map((item) => [item.amountMinor, item.dates]),
        [[2_500, ['2026-09-10', '2026-09-11']]], layer);
    }
  });

  it('pending refunds: a merchant\'s pending refund is listed; a card fee\'s pending give-back is not', () => {
    for (const [layer, rows] of layers([...MERCHANT_FEE, ...CARD_FEE], { status: 'pending' })) {
      const pending = computeCardInsights(rows, SEPTEMBER).pendingRefunds;
      assert.deepEqual([pending?.count, pending?.totalMinor, pending?.ids], [1, 500, ['2026-09-17:SAMPLE PARKING ONLINE PAYMENT FEE REFUND:-500']], layer);
    }
  });

  it('recurring: a merchant\'s monthly fee is a recurring purchase, and its refund no charge; a card fee never recurs', () => {
    const months = ['06', '07', '08', '09'];
    const specs: Spec[] = [
      ...months.map((month): Spec => [`2026-${month}-13`, 'SAMPLE UTILITY ONLINE PAYMENT FEE', 500, 'payment']),
      ['2026-09-19', 'SAMPLE UTILITY ONLINE PAYMENT FEE REFUND', -500, 'payment'],
      ...months.map((month): Spec => [`2026-${month}-14`, 'NSF PAYMENT FEE', 2_700, 'payment']),
      ['2026-09-20', 'NSF PAYMENT FEE REFUND', -2_700, 'payment'],
    ];
    for (const [layer, rows] of layers(specs)) {
      assert.deepEqual(findRecurringCharges(rows, '2026-10-05').map((charge) => [charge.cadence, charge.fixed, charge.occurrences, charge.typicalMinor,
        charge.firstDate, charge.lastDate, charge.active]), [['monthly', true, 4, 500, '2026-06-13', '2026-09-13', true]], layer);
    }
  });

  it('forecast and patterns: the month\'s everyday spending nets both pairs, each in its category', () => {
    for (const [layer, rows] of layers([...MERCHANT_FEE, ...CARD_FEE])) {
      const series = readCardSpendingSeries(enriched(rows), { today: '2026-10-05', currency: 'USD', completeMonths: new Set(['2026-09']) });
      assert.deepEqual([series.months, series.total], [['2026-09'], [500]], layer);
      assert.deepEqual([...series.categories], [[FEES, [500]], [PARKING, [0]]], layer);
    }
  });

  it('card benefits: a benefit\'s statement credit stays an adjustment, its benefit\'s, set against no purchase', () => {
    const platinum = benefitProductById(BENEFITS_CATALOG, 'amex-platinum')!;
    const benefitOf = (item: CardTransaction) => matchBenefitCredit(platinum, {
      id: item.id, cardAccountId: item.cardAccountId, date: item.transactionDate, amountMinor: item.amountMinor, kind: item.kind,
      description: item.description, merchant: item.merchant ?? null,
    });
    const specs: Spec[] = [
      ...groceries('2026-09'), ['2026-09-05', 'SAMPLE AIRLINES', 80_000, 'purchase'], ['2026-09-08', 'AIRLINE FEE CREDIT', -80_000, 'adjustment'],
      ...MERCHANT_FEE, ...CARD_FEE,
    ];
    for (const [layer, rows] of layers(specs)) {
      assert.deepEqual(rows.filter((item) => item.amountMinor < 0).map((item) => [item.description, item.kind, benefitOf(item)]), [
        ['AIRLINE FEE CREDIT', 'adjustment', 'airline-fee'], ['SAMPLE PARKING ONLINE PAYMENT FEE REFUND', 'refund', null],
        ['NSF PAYMENT FEE REFUND', 'adjustment', null],
      ], layer);
      // The airline purchase stays a large one-off the credit is not set against, and the card's fees are as without it.
      const insights = computeCardInsights(rows, SEPTEMBER);
      assert.deepEqual(insights.largePurchases?.items.map((item) => [item.amountMinor, item.refundedMinor]), [[80_000, 0]], layer);
      const without = computeCardInsights(rows.filter((item) => !/AIRLINE/.test(item.description)), SEPTEMBER);
      assert.deepEqual([insights.costs.period.feesMinor, without.costs.period.feesMinor], [500, 500], layer);
    }
  });
});
