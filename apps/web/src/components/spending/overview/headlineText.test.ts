import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_INSIGHT_THRESHOLDS, type CardAccount, type CardSpendingAccounting } from '@finance-tracker/shared';

import { formatMinor, spendingPeriodRange, SPENDING_PERIODS } from '../spendingFormat';
import { assetPurchasesText } from '../whatCounts';
import {
  coverageSummary,
  FILTER_SCOPE,
  headlineBasis,
  headlineComparison,
  headlineComparisonWindow,
  headlineFigure,
  headlineLabel,
  matchingText,
  notInTotalRows,
  recurringPeriod,
  scopeWords,
  soFarMarker,
  windowFigure,
  type ComparedWindow,
} from './headlineText';
import { overviewPeriod } from './overviewText';

// Synthetic figures only.

const usd = (minor: number) => formatMinor(minor, 'USD');
const TODAY = '2026-10-16';

/** A window: complete with `cardsWithData` cards unless told otherwise. */
const window = (spendingMinor: number, options: Partial<ComparedWindow['coverage']> & { to?: string } = {}): ComparedWindow => {
  const cardsWithData = options.cardsWithData ?? 1;
  const cardsExpected = options.cardsExpected ?? Math.max(1, cardsWithData);
  return {
    to: options.to ?? '2026-09-30',
    spendingMinor,
    count: spendingMinor === 0 ? 0 : 3,
    coverage: {
      cardsWithData,
      cardsExpected,
      cardsCovered: options.cardsCovered ?? cardsExpected,
      cardsStartingLater: options.cardsStartingLater ?? 0,
      inProgress: options.inProgress ?? false,
    },
  };
};
const names = { currency: 'USD', periodName: 'August 2026', baselineName: 'July' };

test('the headline names its period, and says "so far" once for a period still going', () => {
  const month = overviewPeriod('month', spendingPeriodRange('month', '2026-10', TODAY), '2026-10', TODAY);
  assert.equal(headlineLabel(month), 'Spent in October so far');
  assert.equal(soFarMarker(month), null);
  const past = overviewPeriod('month', spendingPeriodRange('month', '2026-08', TODAY), '2026-08', TODAY);
  assert.equal(headlineLabel(past), 'Spent in August 2026');
  assert.equal(soFarMarker(past), null);
  const days = overviewPeriod('last90', spendingPeriodRange('last90', '2026-10', TODAY), '2026-10', TODAY);
  assert.equal(headlineLabel(days), 'Spent in the last 90 days');
  assert.equal(soFarMarker(days), 'so far');
  const ytd = overviewPeriod('ytd', spendingPeriodRange('ytd', '2026-10', TODAY), '2026-10', TODAY);
  assert.equal(headlineLabel(ytd), 'Spent in 2026 to date');
  assert.equal(soFarMarker(ytd), null);
});

test('the scope says whose cards, in words', () => {
  const card = { id: 'card-acct-a', issuer: 'chase', owner: 'casey', nickname: 'Sample', last4: '4141', currency: 'USD', status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as CardAccount;
  assert.equal(scopeWords({}), 'All cards');
  assert.equal(scopeWords({ owner: 'alex' }), "Alex's cards");
  assert.equal(scopeWords({ owner: 'joint' }), 'Joint cards');
  assert.equal(scopeWords({ owner: 'alex', card }), 'Chase Sample ··4141 · Casey');
  assert.equal(headlineBasis(-1_500, 'USD'), 'Posted, after $15.00 in refunds');
  assert.equal(headlineBasis(0, 'USD'), 'Posted, after refunds');
});

test('a window with no card data is never $0; a covered window with nothing spent is', () => {
  assert.equal(windowFigure(0, 0, { cardsWithData: 0, cardsCovered: 0, cardsExpected: 0 }, 'USD'), 'No card data');
  assert.equal(windowFigure(0, 0, { cardsWithData: 0, cardsCovered: 0, cardsExpected: 1 }, 'USD'), 'Not recorded');
  assert.equal(windowFigure(0, 0, { cardsWithData: 0, cardsCovered: 1, cardsExpected: 1 }, 'USD'), '$0.00');
  assert.equal(windowFigure(4_200, 1, { cardsWithData: 1, cardsCovered: 0, cardsExpected: 1 }, 'USD'), '$42.00');
  // A pending charge alone, or a part of the cards recorded, proves no zero; posted rows netting to zero do.
  assert.equal(windowFigure(0, 0, { cardsWithData: 1, cardsCovered: 0, cardsExpected: 1 }, 'USD'), 'Not recorded');
  assert.equal(windowFigure(0, 0, { cardsWithData: 0, cardsCovered: 1, cardsExpected: 2 }, 'USD'), 'Not recorded');
  assert.equal(windowFigure(0, 2, { cardsWithData: 1, cardsCovered: 0, cardsExpected: 1 }, 'USD'), '$0.00');
  const figure = (input: Partial<Parameters<typeof headlineFigure>[0]>) =>
    headlineFigure({ amountMinor: 0, rows: 0, record: null, recordFailed: false, currency: 'USD', ...input });
  assert.equal(figure({ amountMinor: null }), '—');
  assert.equal(figure({ amountMinor: 9_599, rows: 2 }), '$95.99');
  // Net refunds: an amount is said even below zero.
  assert.equal(figure({ amountMinor: -1_200, rows: 1 }), '-$12.00');
  // No posted spending: only the record decides, and until it is known nothing is said.
  assert.equal(figure({}), '—');
  assert.equal(figure({ record: { cardsWithData: 0, cardsCovered: 2, cardsExpected: 2 } }), '$0.00');
  assert.equal(figure({ record: { cardsWithData: 0, cardsCovered: 0, cardsExpected: 0 } }), 'No card data');
  assert.equal(figure({ record: { cardsWithData: 1, cardsCovered: 0, cardsExpected: 2 } }), 'Not recorded');
  assert.equal(figure({ recordFailed: true }), 'No posted spending');
});

test('the headline compares with the baseline the tab\'s period names, as the insights do', () => {
  for (const { id } of SPENDING_PERIODS) {
    const range = spendingPeriodRange(id, '2026-10', TODAY);
    const period = overviewPeriod(id, range, '2026-10', TODAY);
    const picked = headlineComparisonWindow(period, range.previous)!;
    if (range.previous) {
      assert.deepEqual([picked.baselineFrom, picked.baselineTo], [range.previous.from, range.previous.to], id);
    } else {
      assert.equal(picked.key, 'previous', id);
    }
  }
  // Six months: against the same six months last year, not the six before.
  const range = spendingPeriodRange('last6m', '2026-10', TODAY);
  assert.equal(headlineComparisonWindow(overviewPeriod('last6m', range, '2026-10', TODAY), range.previous)!.key, 'year');
});

test('two complete windows are compared in one sentence, with the baseline\'s figure', () => {
  assert.deepEqual(headlineComparison(window(272_599), window(17_599), names), {
    kind: 'compared', text: '$2,550.00 more than July', tone: 'more', baseline: { key: 'baseline', label: 'July', figure: '$175.99' },
  });
  // Two genuine zeros (each card's dates recorded, nothing spent): compared, and said as $0.
  assert.deepEqual(headlineComparison(window(0, { cardsWithData: 0, cardsCovered: 1 }), window(0, { cardsWithData: 0, cardsCovered: 1 }), names), {
    kind: 'compared', text: 'The same as July: $0.00 difference', tone: 'same', baseline: { key: 'baseline', label: 'July', figure: '$0.00' },
  });
  // A genuine zero beside a month with spending: data from different numbers of cards, so not compared, yet still $0.
  const zero = headlineComparison(window(9_599), window(0, { cardsWithData: 0, cardsCovered: 1 }), names);
  assert.equal(zero.kind === 'notComparable' && zero.reason, 'the two periods have data from different numbers of cards');
  assert.deepEqual(zero.kind === 'notComparable' && zero.rows.map((row) => row.figure), ['$95.99', '$0.00']);
});

test('windows that can\'t be compared say why, label both figures, and never read a missing history as $0', () => {
  const inProgress = headlineComparison(window(9_599, { inProgress: true, to: '2026-10-16' }), window(266_599),
    { currency: 'USD', periodName: 'October so far', baselineName: 'September at this point' });
  assert.deepEqual(inProgress, {
    kind: 'notComparable',
    reason: 'this period is still in progress',
    rows: [
      { key: 'current', label: 'October so far', figure: '$95.99' },
      { key: 'baseline', label: 'September at this point', figure: '$2,665.99' },
    ],
    why: [{ about: 'current', text: 'October so far: still going through Oct 16, and recent charges may not have posted yet' }],
  });

  // No card data a year before: never "$0.00" and never "no spending".
  const missing = headlineComparison(window(109_000, { inProgress: true, to: '2026-10-16' }),
    window(0, { cardsWithData: 0, cardsExpected: 0, cardsCovered: 0, cardsStartingLater: 1 }),
    { currency: 'USD', periodName: 'the last 12 months', baselineName: 'the 12 months before' });
  assert.equal(missing.kind, 'notComparable');
  if (missing.kind !== 'notComparable') return;
  assert.equal(missing.reason, 'no card data for the 12 months before');
  assert.deepEqual(missing.rows.map((row) => `${row.label}: ${row.figure}`), ['The last 12 months: $1,090.00', 'The 12 months before: No card data']);
  assert.deepEqual(missing.why.map((item) => item.about), ['current', 'baseline', 'both']);
  for (const text of [missing.reason, ...missing.rows.map((row) => row.figure), ...missing.why.map((item) => item.text)]) {
    assert.doesNotMatch(text, /no spending|%/i);
  }

  // A partly recorded baseline, and two windows with data from different numbers of cards.
  const partial = headlineComparison(window(17_599), window(10_599, { cardsCovered: 0 }), names);
  assert.equal(partial.kind === 'notComparable' && partial.reason, 'July may be incomplete');
  assert.equal(partial.kind === 'notComparable' && partial.rows[1].figure, '$105.99');
  const cards = headlineComparison(window(17_599, { cardsWithData: 2 }), window(10_599, { cardsWithData: 1, cardsExpected: 2 }), names);
  assert.equal(cards.kind === 'notComparable' && cards.reason, 'the two periods have data from different numbers of cards');
  // A card that was there with nothing recorded for the period: "no record", not "no card data", and never $0.
  const silent = headlineComparison(window(0, { cardsWithData: 0, cardsCovered: 0, cardsExpected: 1, inProgress: true, to: '2026-08-20' }), window(4_200), names);
  assert.equal(silent.kind === 'notComparable' && silent.reason, 'no record for August 2026');
  assert.deepEqual(silent.kind === 'notComparable' && silent.rows.map((row) => row.figure), ['Not recorded', '$42.00']);
  // One pending charge and no recorded dates: still not a $0 baseline.
  const pendingOnly = headlineComparison(window(4_200), window(0, { cardsWithData: 1, cardsCovered: 0, cardsExpected: 1 }), names);
  assert.equal(pendingOnly.kind === 'notComparable' && pendingOnly.reason, 'no record for July');
  assert.deepEqual(pendingOnly.kind === 'notComparable' && pendingOnly.rows.map((row) => row.figure), ['$42.00', 'Not recorded']);
});

test('what is not in the total: one labelled row per kind there is, from the same summary', () => {
  const rows = notInTotalRows({
    totals: { paymentsMinor: -83_734, paymentCount: 2, otherMinor: 3_000, otherCount: 1, assetPurchasesMinor: 412_399, assetPurchaseCount: 1 },
    pending: { count: 1, netMinor: 700 },
    paidFromBrokerage: 1,
    currency: 'USD',
  });
  assert.deepEqual(rows.map((row) => [row.key, `${row.amount} ${row.text}`, row.note]), [
    ['pending', '$7.00 pending · 1 not posted yet; not included', null],
    ['payments', '$837.34 card payments · 2 transfers, not spending', '1 possibly paid from brokerage cash'],
    ['metals', '$4,123.99 precious metals bought · not counted', null],
    ['other', '$30.00 other, not counted · 1 cash advance or the like', null],
  ]);
  // The metals row says what What counts says of the same purchases.
  const entry = { currency: 'USD', notSpending: { assetPurchases: { count: 1, netMinor: 412_399 } } } as unknown as CardSpendingAccounting;
  assert.equal(`${rows[2].amount} ${rows[2].text}`, assetPurchasesText(entry));
  // A pending refund keeps its sign; nothing left out says nothing.
  assert.equal(notInTotalRows({ totals: undefined, pending: { count: 1, netMinor: -2_500 }, paidFromBrokerage: 0, currency: 'USD' })[0].amount, '−$25.00');
  assert.deepEqual(notInTotalRows({
    totals: { paymentsMinor: 0, paymentCount: 0, otherMinor: 0, otherCount: 0 }, pending: { count: 0, netMinor: 0 }, paidFromBrokerage: 0, currency: 'USD',
  }), []);
});

test('the panels that ignore the list\'s filters say their actual period and scope', () => {
  assert.equal(FILTER_SCOPE, 'Ignores search and category/merchant filters; person and card apply');
  const period = recurringPeriod('2024-09-20');
  assert.equal(period, `As of Sep 20, 2024, from the last ${CARD_INSIGHT_THRESHOLDS.recurringLookbackDays} days of charges `
    + `(${CARD_INSIGHT_THRESHOLDS.recurringAnnualLookbackDays} days for yearly ones)`);
  assert.equal(matchingText(1), '1 matching charge');
  assert.equal(matchingText(1_204), '1,204 matching charges');
  assert.equal(coverageSummary(3, 0), '3 cards');
  assert.equal(coverageSummary(1, 2), '1 card · 2 gaps');
  assert.equal(usd(0), '$0.00');
});
