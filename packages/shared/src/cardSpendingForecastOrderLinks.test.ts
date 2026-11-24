import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { syntheticSpendingLedger } from './__fixtures__/syntheticSpendingLedger.js';
import { splitLargeCardPurchases, type CardOrderLinks } from './cardInsights.js';
import { resolveCardSpendingExclusions } from './cardSpendingExclusions.js';
import {
  cardSpendingPatterns,
  forecastCardSpending,
  readCardSpendingSeries,
  type CardForecastRow,
  type CardSpendingForecast,
  type CardSpendingForecastInput,
} from './cardSpendingForecast.js';

// Synthetic rows only: fictional merchants, made-up amounts, dates, card ids and order references.
//
// The forecast's one-off split reads the order links the insights and the overview read (cardLargePurchaseOrders.test.ts):
// a credit one of whose orders has a charge linked to a card row, anywhere in the household, pays back only one of those
// charges; a credit linked to no order, or to orders with no linked charge, goes by the merchant rule. Both of the
// forecast's splits read them, and neither changes the rows it splits: complete months' rows, and this month's with them.

let sequence = 0;
function tx(transactionDate: string, amountMinor: number, description: string, extra: Partial<CardForecastRow> = {}): CardForecastRow {
  sequence += 1;
  return {
    id: `fo-${String(sequence).padStart(6, '0')}`,
    cardAccountId: 'card-a',
    transactionDate,
    status: 'posted',
    amountMinor,
    currency: 'USD',
    kind: amountMinor < 0 ? 'refund' : 'purchase',
    description,
    merchant: null,
    issuerCategory: null,
    userCategory: null,
    ...extra,
  };
}

function monthsFrom(start: string, count: number): string[] {
  const index = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, offset) => {
    const value = index + offset;
    return `${Math.floor(value / 12)}-${String((value % 12) + 1).padStart(2, '0')}`;
  });
}

const day = (month: string, value: number) => `${month}-${String(value).padStart(2, '0')}`;
const RESTAURANT = 'Restaurant-Restaurant';
const RETAIL = 'Merchandise & Supplies-General Retail';
const AUDIO = 'Merchandise & Supplies-Electronics Stores';

const input = (today: string, completeMonths: Iterable<string>, extra: Partial<CardSpendingForecastInput> = {}): CardSpendingForecastInput =>
  ({ today, currency: 'USD', completeMonths: new Set(completeMonths), ...extra });

/**
 * Order links as a snapshot gives them: each row's orders, and each order's charges linked to a card row (its rows
 * with a positive amount) among `household`, every card row, whatever rows the forecast is given; `elsewhere` adds
 * charges linked to rows outside them (a card out of view).
 */
function orderLinks(
  links: ReadonlyMap<string, readonly string[]>,
  household: readonly CardForecastRow[],
  elsewhere: ReadonlyMap<string, readonly string[]> = new Map(),
): CardOrderLinks {
  const charges = new Map<string, string[]>([...elsewhere].map(([order, ids]) => [order, [...ids]]));
  for (const row of household) {
    if (row.amountMinor <= 0) continue;
    for (const order of links.get(row.id) ?? []) charges.set(order, [...(charges.get(order) ?? []), row.id]);
  }
  return { orderRefsOf: (id) => links.get(id), chargeIdsOf: (order) => charges.get(order) };
}

/** Everything the forecast, its series and the patterns say. */
function answers(rows: readonly CardForecastRow[], forecastInput: CardSpendingForecastInput) {
  const series = readCardSpendingSeries(rows, forecastInput);
  return {
    forecast: forecastCardSpending(rows, forecastInput),
    patterns: cardSpendingPatterns(rows, forecastInput),
    series: { months: series.months, total: series.total, categories: [...series.categories] },
  };
}

/** A forecast without what order links may move: the months' one-off and everyday parts, the fit's refunds and one-offs, the forecasts, and the pace's everyday parts. */
function withoutSplitFields(forecast: CardSpendingForecast) {
  const { total: _total, categories: _categories, ...rest } = structuredClone(forecast);
  const pace: Record<string, unknown> = { ...rest.pace };
  for (const key of ['everydaySpentMinor', 'oneOffsMinor', 'restMinor', 'typicalMinor', 'everydayProjectedMinor', 'everydayRange80', 'projectedMinor', 'projectedRange80']) {
    delete pace[key];
  }
  return {
    ...rest,
    months: rest.months.map(({ oneOffsMinor: _oneOffs, everydayMinor: _everyday, ...book }) => book),
    fit: rest.fit && (({ oneOffRefundsMinor: _refunds, oneOffsMinor: _oneOffs, ...fit }) => fit)(rest.fit),
    pace,
  };
}

/** The identities every forecast keeps: per split month, one-offs + everyday = spending; the fit's one-offs are its months'. */
function assertBooksAddUp(forecast: CardSpendingForecast, label: string) {
  for (const book of forecast.months) {
    if (book.oneOffsMinor === null) continue;
    assert.equal(book.oneOffsMinor + book.everydayMinor!, book.spendingMinor, `${label} ${book.month}`);
  }
  if (forecast.fit) {
    assert.equal(forecast.fit.oneOffsMinor, forecast.fit.oneOffPurchasesMinor - forecast.fit.oneOffRefundsMinor, label);
    assert.equal(forecast.fit.oneOffsMinor, forecast.months.filter((book) => book.complete).reduce((total, book) => total + book.oneOffsMinor!, 0), label);
  }
  const { pace } = forecast;
  assert.equal(pace.spentMinor, pace.everydaySpentMinor + pace.oneOffsMinor, `${label} pace`);
  if (pace.everydayProjectedMinor !== null) assert.equal(pace.projectedMinor, pace.everydayProjectedMinor + pace.oneOffsMinor, `${label} pace`);
}

describe('order links in the forecast: exactly as before without them, or with links that agree or cannot decide', () => {
  let refundsSetAgainst = 0;
  for (const seed of [3, 7, 11, 19, 42]) {
    it(`synthetic ledger ${seed}`, () => {
      const ledger = syntheticSpendingLedger({ seed, months: 20, start: '2025-01', foreign: true });
      const { rows } = ledger;
      const today = '2026-08-17';
      const exclusions = resolveCardSpendingExclusions(rows);
      const complete = monthsFrom('2025-04', 16).filter((month) => month !== '2025-10');
      const plain = answers(rows, input(today, complete, { exclusions }));
      const completeRows = rows.filter((row) => complete.includes(row.transactionDate.slice(0, 7)));
      refundsSetAgainst += splitLargeCardPurchases(completeRows, { currency: 'USD', through: '2026-07-31', exclusions }).refundsSetAgainstLarge.size;
      const mapped = (ordersOf: (row: CardForecastRow) => string[] | undefined) => orderLinks(new Map(rows.flatMap((row) => {
        const orders = ordersOf(row);
        return orders ? [[row.id, orders] as const] : [];
      })), rows);
      const variants: Array<[string, CardOrderLinks]> = [
        ['no link answered', { orderRefsOf: () => undefined, chargeIdsOf: () => undefined }],
        ['empty links', { orderRefsOf: () => [], chargeIdsOf: () => [] }],
        ['only purchases linked', mapped((row) => (row.amountMinor > 0 ? [`order-${row.id}`] : undefined))],
        // Undecided: credits linked to orders whose charges are linked to no card row go by the merchant rule.
        ['credits linked to orders with no linked charge', mapped((row) => (row.amountMinor < 0 ? [`order-held-${row.id}`] : undefined))],
        // The merchant rule needs the same card: one order per card is every pair's own.
        ['one order per card', mapped((row) => [`order-${row.cardAccountId}`])],
        ['several, one shared per card', mapped((row) => [`order-${row.id}`, `order-${row.cardAccountId}`])],
      ];
      for (const [name, links] of variants) assert.deepEqual(answers(rows, input(today, complete, { exclusions, orderLinks: links })), plain, `seed ${seed}: ${name}`);
    });
  }
  it('the ledgers set refunds against large purchases in their complete months', () => {
    assert.ok(refundsSetAgainst >= 3, `${refundsSetAgainst} refunds set against large purchases`);
  });
});

describe('order links in the forecast: a credit for another order in a complete month', () => {
  // As #172's complete-months scenario: twelve months July 2025 to June 2026 but March 2026 complete, three small
  // purchases in each; a large one-off in February 2026 (order f), and a credit at its merchant in April. Partial: March
  // 2026, which holds a small charge for order m at the same merchant, and July 2026; August 2026 is in progress.
  const today = '2026-08-15';
  const complete = monthsFrom('2025-07', 12).filter((month) => month !== '2026-03');
  const store = (date: string, amountMinor: number, index: number) => tx(date, amountMinor, `SAMPLE STORE ${index}`, { issuerCategory: RETAIL });
  const oneOff = tx('2026-02-15', 60_000, 'SAMPLE AUDIO SHOP', { issuerCategory: AUDIO });
  const credit = tx('2026-04-10', -20_000, 'SAMPLE AUDIO SHOP', { issuerCategory: AUDIO });
  const marchCharge = tx('2026-03-05', 3_000, 'SAMPLE AUDIO SHOP', { issuerCategory: AUDIO });
  const rows: CardForecastRow[] = [
    ...complete.flatMap((month, index) => [
      store(day(month, 5), 10_000 + 17 * index, 3 * index),
      store(day(month, 18), 12_000 + 23 * index, 3 * index + 1),
      tx(day(month, 27), 8_000 + 7 * index, `SAMPLE BISTRO ${index}`, { issuerCategory: RESTAURANT }),
    ]),
    oneOff, credit, marchCharge,
    ...[2, 6, 11].map((date, index) => store(day('2026-08', date), 9_000 + 31 * index, 100 + index)),
  ];
  const linked = (creditOrders: string[], elsewhere: ReadonlyMap<string, readonly string[]> = new Map(), household: readonly CardForecastRow[] = rows) =>
    orderLinks(new Map([[oneOff.id, ['order-f']], [marchCharge.id, ['order-m']], [credit.id, creditOrders]]), household, elsewhere);
  const before = answers(rows, input(today, complete));

  it('before order links: the credit pays the February one-off back', () => {
    const april = before.forecast.months.find((book) => book.month === '2026-04')!;
    assert.equal(april.oneOffsMinor, -20_000);
    assert.deepEqual([before.forecast.fit!.oneOffPurchases, before.forecast.fit!.oneOffPurchasesMinor, before.forecast.fit!.oneOffRefundsMinor], [1, 60_000, 20_000]);
    assert.ok(!before.forecast.categories.some((item) => item.category === AUDIO), 'the one-off and the credit are in no category');
    assertBooksAddUp(before.forecast, 'before');
  });

  it('decisive, the same order, or undecided (its order\'s charge linked to no card row): exactly as before', () => {
    assert.deepEqual(answers(rows, input(today, complete, { orderLinks: linked(['order-f']) })), before);
    assert.deepEqual(answers(rows, input(today, complete, { orderLinks: linked(['order-held']) })), before);
  });

  it('decisive, another order, charged on a card out of view or in a partial month: it pays back no one-off', () => {
    for (const [label, links] of [
      ['charged on another card', linked(['order-x'], new Map([['order-x', ['charge-on-another-card']]]))],
      ['charged in a partial month', linked(['order-m'])],
    ] as const) {
      const after = answers(rows, input(today, complete, { orderLinks: links }));
      const book = (month: string, of = after) => of.forecast.months.find((item) => item.month === month)!;
      // April's credit is everyday spending; February's one-off is a one-off as before, costing all of it.
      assert.deepEqual([book('2026-04').oneOffsMinor, book('2026-04').everydayMinor], [0, book('2026-04', before).everydayMinor! - 20_000], label);
      assert.deepEqual(book('2026-02'), book('2026-02', before), label);
      assert.deepEqual(after.forecast.fit, { ...before.forecast.fit!, oneOffRefundsMinor: 0, oneOffsMinor: 60_000 }, label);
      assert.equal(after.forecast.oneOffThresholdMinor, before.forecast.oneOffThresholdMinor);
      // The credit's category now has everyday spending (April's), so it is a series of its own.
      const audio = after.series.categories.find(([category]) => category === AUDIO);
      assert.ok(audio && after.forecast.categories.some((item) => item.category === AUDIO), label);
      assert.deepEqual(audio[1].filter((value) => value !== null && value !== 0), [-20_000], label);
      // Only one-off and everyday figures move; every identity holds.
      assert.deepEqual(withoutSplitFields(after.forecast), withoutSplitFields(before.forecast), label);
      assert.deepEqual([after.patterns.checks, after.patterns.bills], [before.patterns.checks, before.patterns.bills], label);
      assertBooksAddUp(after.forecast, label);
    }
    // Both are decisive, so both answers are the same.
    assert.deepEqual(
      answers(rows, input(today, complete, { orderLinks: linked(['order-m']) })),
      answers(rows, input(today, complete, { orderLinks: linked(['order-x'], new Map([['order-x', ['charge-on-another-card']]])) })),
    );
  });

  it('decides a link from the household\'s links, not the rows split: order m charged in a partial month stays decisive', () => {
    // Order m's only charge is in March, a partial month, so it is in neither of the forecast's splits.
    const completeRows = rows.filter((row) => complete.includes(row.transactionDate.slice(0, 7)));
    assert.ok(!completeRows.includes(marchCharge));
    const household = answers(rows, input(today, complete, { orderLinks: linked(['order-m']) }));
    assert.equal(household.forecast.months.find((book) => book.month === '2026-04')!.oneOffsMinor, 0);
    // Decided from the complete months' rows instead, order m would look undecided and its credit would pay the
    // February one-off back: the review's defect, back in the forecast.
    const local = answers(rows, input(today, complete, { orderLinks: linked(['order-m'], new Map(), completeRows) }));
    assert.deepEqual(local, before);
  });
});

describe('order links in the forecast: a credit this month moves only this month\'s books', () => {
  // Twelve complete months, August 2025 to July 2026; a large one-off on July 10 (order j); a credit at its merchant on
  // August 5, this month, within its 90 days.
  const today = '2026-08-20';
  const complete = monthsFrom('2025-08', 12);
  const rows: CardForecastRow[] = [
    ...complete.flatMap((month, index) => [
      tx(day(month, 4), 10_000 + 19 * index, `SAMPLE STORE ${2 * index}`, { issuerCategory: RETAIL }),
      tx(day(month, 16), 11_000 + 29 * index, `SAMPLE STORE ${2 * index + 1}`, { issuerCategory: RETAIL }),
      tx(day(month, 24), 8_000 + 11 * index, `SAMPLE BISTRO ${index}`, { issuerCategory: RESTAURANT }),
    ]),
    tx('2026-07-10', 60_000, 'SAMPLE AUDIO SHOP', { issuerCategory: AUDIO }),
    tx('2026-08-05', -15_000, 'SAMPLE AUDIO SHOP', { issuerCategory: AUDIO }),
    ...[3, 9, 14].map((date, index) => tx(day('2026-08', date), 9_500 + 37 * index, `SAMPLE STORE ${200 + index}`, { issuerCategory: RETAIL })),
  ];
  const [oneOff, credit] = rows.filter((row) => row.description === 'SAMPLE AUDIO SHOP');
  const linked = (creditOrders: string[]) => orderLinks(new Map([[oneOff.id, ['order-j']], [credit.id, creditOrders]]), rows,
    new Map([['order-x', ['charge-on-another-card']]]));
  /** Everything computed for the complete months: what a credit this month may never move. */
  const learned = (result: ReturnType<typeof answers>) => ({
    threshold: result.forecast.oneOffThresholdMinor,
    books: result.forecast.months.filter((book) => book.complete),
    fit: result.forecast.fit,
    total: result.forecast.total,
    categories: result.forecast.categories,
    series: result.series,
    patterns: result.patterns,
    paceHistory: [result.forecast.pace.historyMonths, result.forecast.pace.from, result.forecast.pace.to, result.forecast.pace.restMinor, result.forecast.pace.typicalMinor],
  });
  const before = answers(rows, input(today, complete));

  it('the same order, or undecided: exactly as before, the credit paying July\'s one-off back this month', () => {
    const august = before.forecast.months.find((book) => book.month === '2026-08')!;
    assert.equal(august.oneOffsMinor, -15_000);
    assert.equal(before.forecast.pace.oneOffsMinor, -15_000);
    assert.deepEqual(answers(rows, input(today, complete, { orderLinks: linked(['order-j']) })), before);
    assert.deepEqual(answers(rows, input(today, complete, { orderLinks: linked(['order-held']) })), before);
  });

  it('another order: this month\'s books and everyday pace move by the credit, the projected month and everything learned do not', () => {
    const after = answers(rows, input(today, complete, { orderLinks: linked(['order-x']) }));
    assert.deepEqual(learned(after), learned(before));
    const august = (of: typeof before) => of.forecast.months.find((book) => book.month === '2026-08')!;
    assert.deepEqual([august(after).oneOffsMinor, august(after).everydayMinor], [0, august(before).everydayMinor! - 15_000]);
    const [now, then] = [after.forecast.pace, before.forecast.pace];
    assert.deepEqual([now.spentMinor, now.oneOffsMinor, now.everydaySpentMinor], [then.spentMinor, 0, then.everydaySpentMinor - 15_000]);
    assert.equal(now.everydayProjectedMinor, then.everydayProjectedMinor! - 15_000);
    // The month's total is the everyday estimate plus the one-offs: the credit moves from one to the other.
    assert.deepEqual([now.projectedMinor, now.projectedRange80], [then.projectedMinor, then.projectedRange80]);
    assertBooksAddUp(after.forecast, 'after');
  });
});
