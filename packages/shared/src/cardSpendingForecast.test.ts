import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { syntheticSpendingLedger, seededRandom } from './__fixtures__/syntheticSpendingLedger.js';
import { splitLargeCardPurchases } from './cardInsights.js';
import { summarizeCardSpending } from './cardSpending.js';
import { resolveCardSpendingExclusions } from './cardSpendingExclusions.js';
import {
  CARD_SPENDING_FORECAST,
  cardSpendingPatterns,
  forecastCardSpending,
  readCardSpendingSeries,
  type CardForecastRow,
  type CardSpendingForecastInput,
} from './cardSpendingForecast.js';

// Synthetic rows only: fictional merchants and made-up amounts, dates and card ids.

let sequence = 0;
function tx(transactionDate: string, amountMinor: number, description: string, extra: Partial<CardForecastRow> = {}): CardForecastRow {
  sequence += 1;
  return {
    id: `fc-${String(sequence).padStart(6, '0')}`,
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

function daysIn(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

const day = (month: string, value: number) => `${month}-${String(value).padStart(2, '0')}`;
const GROCERIES = 'Merchandise & Supplies-Groceries';
const RESTAURANT = 'Restaurant-Restaurant';

/** $10 of groceries every day of every month given, through `lastDay` of the last one. */
function dailyGroceries(months: readonly string[], lastDay?: number): CardForecastRow[] {
  return months.flatMap((month, index) => {
    const days = index === months.length - 1 && lastDay !== undefined ? lastDay : daysIn(month);
    return Array.from({ length: days }, (_, offset) => tx(day(month, offset + 1), 1_000, 'SAMPLE GROCER #0012', { issuerCategory: GROCERIES }));
  });
}

const input = (today: string, completeMonths: Iterable<string>, extra: Partial<CardSpendingForecastInput> = {}): CardSpendingForecastInput =>
  ({ today, currency: 'USD', completeMonths: new Set(completeMonths), ...extra });

describe('the months: spending = one-offs + everyday, and it is the summary\'s spending', () => {
  for (const seed of [3, 7, 11, 19, 42]) {
    it(`synthetic ledger ${seed}`, () => {
      const ledger = syntheticSpendingLedger({ seed, months: 20, start: '2025-01', foreign: true });
      const today = '2026-08-17';
      const exclusions = resolveCardSpendingExclusions(ledger.rows);
      // The first three months and one in the middle are partial.
      const complete = monthsFrom('2025-04', 16).filter((month) => month !== '2025-10');
      const forecast = forecastCardSpending(ledger.rows, input(today, complete, { exclusions }));
      const summary = summarizeCardSpending(ledger.rows, { exclusions });
      // What it learns from: the complete months' rows alone, split as of their last day; this month's rows are split
      // with them, as of that same day, so they move nothing learned.
      const completeRows = ledger.rows.filter((row) => complete.includes(row.transactionDate.slice(0, 7)));
      const learned = { currency: 'USD', through: '2026-07-31', exclusions };
      const fitSplit = splitLargeCardPurchases(completeRows, learned);
      const currentSplit = splitLargeCardPurchases([...completeRows, ...ledger.rows.filter((row) => row.transactionDate.startsWith('2026-08'))], learned);
      assert.equal(forecast.oneOffThresholdMinor, fitSplit.thresholdMinor);
      assert.equal(currentSplit.thresholdMinor, fitSplit.thresholdMinor);
      const byMonth = new Map(summary.byMonth.filter((item) => item.currency === 'USD').map((item) => [item.month, item.spendingMinor]));
      assert.equal(forecast.months[0].month, '2025-01');
      assert.equal(forecast.months[forecast.months.length - 1].month, '2026-08');
      for (const book of forecast.months) {
        assert.equal(book.spendingMinor, byMonth.get(book.month) ?? 0, `${book.month}: the summary's spending`);
        assert.equal(book.complete, complete.includes(book.month));
        assert.equal(book.inProgress, book.month === '2026-08');
        if (!book.complete && !book.inProgress) {
          assert.deepEqual([book.oneOffsMinor, book.everydayMinor], [null, null], `${book.month}: a partial month is never split`);
          continue;
        }
        assert.equal(book.oneOffsMinor! + book.everydayMinor!, book.spendingMinor, `${book.month}: one-offs + everyday`);
        const split = book.inProgress ? currentSplit : fitSplit;
        const large = split.large.filter((item) => item.row.transactionDate.startsWith(book.month)).reduce((total, item) => total + item.row.amountMinor, 0);
        const setAgainst = ledger.rows.filter((row) => row.transactionDate.startsWith(book.month))
          .reduce((total, row) => total + (split.refundsSetAgainstLarge.get(row.id) ?? 0), 0);
        assert.equal(book.oneOffsMinor, large - setAgainst, `${book.month}: one-offs are the large purchases less refunds set against them`);
      }
      // This month's pace reconciles: its parts add up, and its ranges move with them.
      const { pace } = forecast;
      assert.equal(pace.spentMinor, pace.everydaySpentMinor + pace.oneOffsMinor);
      assert.equal(pace.everydayProjectedMinor, pace.everydaySpentMinor + pace.restMinor!);
      assert.equal(pace.projectedMinor, pace.everydayProjectedMinor! + pace.oneOffsMinor);
      assert.ok(pace.everydayRange80 && pace.everydayRange80.coverage.tested === pace.historyMonths);
      assert.deepEqual(pace.projectedRange80, {
        lowerMinor: pace.everydayRange80.lowerMinor + pace.oneOffsMinor,
        upperMinor: pace.everydayRange80.upperMinor + pace.oneOffsMinor,
        coverage: pace.everydayRange80.coverage,
      });
      // The fitted series: every category's month adds up to everyday spending, and partial months are never fitted.
      const series = readCardSpendingSeries(ledger.rows, input(today, complete, { exclusions }));
      assert.deepEqual(series.months, monthsFrom('2025-04', 16));
      series.months.forEach((month, index) => {
        const total = series.total[index];
        if (month === '2025-10') {
          assert.equal(total, null);
          for (const values of series.categories.values()) assert.equal(values[index], null);
          return;
        }
        assert.equal(total, forecast.months.find((book) => book.month === month)!.everydayMinor);
        assert.equal([...series.categories.values()].reduce((sum, values) => sum + (values[index] as number), 0), total, `${month}: categories add up`);
      });
      const fit = forecast.fit!;
      assert.deepEqual([fit.from, fit.to, fit.completeMonths, fit.partialMonths], ['2025-04', '2026-07', 15, 1]);
      const fittedLarge = fitSplit.large.filter((item) => complete.includes(item.row.transactionDate.slice(0, 7)));
      assert.deepEqual([fit.oneOffPurchases, fit.oneOffPurchasesMinor], [fittedLarge.length, fittedLarge.reduce((total, item) => total + item.row.amountMinor, 0)]);
      assert.equal(fit.oneOffsMinor, fit.oneOffPurchasesMinor - fit.oneOffRefundsMinor);
      assert.equal(fit.oneOffsMinor, forecast.months.filter((book) => book.complete).reduce((total, book) => total + book.oneOffsMinor!, 0));
      assert.deepEqual(forecast.horizon, ['2026-09', '2026-10', '2026-11']);
      // The total is forecast from its own series; each category from its own.
      assert.equal(forecast.total!.historyMonths, 15);
      assert.ok(forecast.categories.length > 0 && forecast.categories.every((item) => item.historyMonths === 15));
      // Every range given carries its tested coverage.
      for (const item of [forecast.total!, ...forecast.categories]) {
        for (const month of item.months) {
          for (const range of [month.range80, month.range95]) {
            if (range) assert.ok(range.coverage.tested > 0 && range.coverage.inside <= range.coverage.tested, `${item.category}: ${JSON.stringify(range)}`);
          }
        }
      }
    });
  }
});

describe('complete months only: rows outside them never change what is learned for them', () => {
  // Twelve complete months, July 2025 to June 2026, but March 2026, with three small purchases each; a large one-off in
  // February 2026, and part of it refunded in April. Partial: every month before July 2025, March 2026 and July 2026;
  // August 2026 is in progress.
  const today = '2026-08-15';
  const complete = monthsFrom('2025-07', 12).filter((month) => month !== '2026-03');
  const store = (date: string, amountMinor: number, index: number) => tx(date, amountMinor, `SAMPLE STORE ${index}`, { issuerCategory: 'Merchandise & Supplies-General Retail' });
  const base: CardForecastRow[] = [
    ...complete.flatMap((month, index) => [
      store(day(month, 5), 10_000 + 17 * index, 3 * index),
      store(day(month, 18), 12_000 + 23 * index, 3 * index + 1),
      tx(day(month, 27), 8_000 + 7 * index, `SAMPLE BISTRO ${index}`, { issuerCategory: RESTAURANT }),
    ]),
    tx('2026-02-15', 60_000, 'SAMPLE AUDIO SHOP', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' }),
    tx('2026-04-10', -20_000, 'SAMPLE AUDIO SHOP', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' }),
    ...[2, 6, 11].map((date, index) => store(day('2026-08', date), 9_000 + 31 * index, 100 + index)),
  ];
  const added: Record<string, CardForecastRow[]> = {
    // Large purchases in a partial month would raise the one-off threshold over the February one-off.
    'large purchases in a partial month': Array.from({ length: 100 }, (_, index) =>
      tx(day('2026-07', 1 + (index % 28)), 200_000 + index, `SAMPLE TRAVEL DESK ${index}`, { issuerCategory: 'Travel-Travel Agencies' })),
    // A refund in a partial month between complete ones would take the February one-off's refund room before April's.
    'a refund in a partial month between complete ones': [
      tx('2026-03-10', -50_000, 'SAMPLE AUDIO SHOP', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' }),
    ],
    // The same price a year earlier would make the February one-off look like a yearly charge.
    'the same charge a year before the record is complete': [
      tx('2025-02-15', 60_000, 'SAMPLE AUDIO SHOP', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' }),
    ],
    // This month's rows: large purchases, a refund and more everyday spending.
    "this month's rows": [
      tx('2026-08-03', 900_000, 'SAMPLE FURNITURE HALL', { issuerCategory: 'Merchandise & Supplies-Furnishing' }),
      tx('2026-08-07', 750_000, 'SAMPLE AIRLINE TICKETS', { issuerCategory: 'Travel-Airline' }),
      tx('2026-08-09', -5_000, 'SAMPLE AUDIO SHOP', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' }),
      ...[1, 4, 8, 12, 14].map((date, index) => store(day('2026-08', date), 15_000 + 101 * index, 200 + index)),
    ],
  };
  added['all of them at once'] = Object.values(added).flat();

  /** Everything computed for the complete months, and what this month's rows may not move. */
  function learned(rows: readonly CardForecastRow[]) {
    const forecast = forecastCardSpending(rows, input(today, complete));
    const patterns = cardSpendingPatterns(rows, input(today, complete));
    const series = readCardSpendingSeries(rows, input(today, complete));
    const { pace } = forecast;
    return {
      threshold: forecast.oneOffThresholdMinor,
      books: forecast.months.filter((book) => book.complete),
      fit: forecast.fit,
      total: forecast.total,
      categories: forecast.categories,
      series: { months: series.months, total: series.total, categories: [...series.categories] },
      lastMonth: { checks: patterns.checks.filter((check) => check.window === 'month'), anomalies: patterns.anomalies.filter((item) => item.window === 'month') },
      paceHistory: [pace.historyMonths, pace.from, pace.to, pace.restMinor, pace.typicalMinor, pace.everydayRange80 && {
        lower: pace.everydayRange80.lowerMinor - pace.everydaySpentMinor,
        upper: pace.everydayRange80.upperMinor - pace.everydaySpentMinor,
        coverage: pace.everydayRange80.coverage,
      }],
    };
  }
  const before = learned(base);

  it('the base: the February one-off is one, April\'s refund is set against it, and the forecast is ranged', () => {
    const forecast = forecastCardSpending(base, input(today, complete));
    const february = forecast.months.find((book) => book.month === '2026-02')!;
    const april = forecast.months.find((book) => book.month === '2026-04')!;
    assert.deepEqual([february.oneOffsMinor, april.oneOffsMinor], [60_000, -20_000]);
    assert.ok(forecast.oneOffThresholdMinor <= 60_000);
    assert.equal(forecast.fit!.completeMonths, 11);
  });

  for (const [name, rows] of Object.entries(added)) {
    it(`${name}: every complete month's books, the fit, the forecasts and the baselines are the same`, () => {
      assert.deepEqual(learned([...base, ...rows]), before);
      if (name === "this month's rows" || name === 'all of them at once') return;
      // Rows outside this month leave this month's pace and its check untouched too.
      const plain = forecastCardSpending(base, input(today, complete));
      const more = forecastCardSpending([...base, ...rows], input(today, complete));
      assert.deepEqual(more.pace, plain.pace);
      assert.deepEqual(cardSpendingPatterns([...base, ...rows], input(today, complete)).checks, cardSpendingPatterns(base, input(today, complete)).checks);
    });
  }

  it('this month\'s one-offs are found by the threshold learned from complete months', () => {
    const forecast = forecastCardSpending([...base, ...added["this month's rows"]], input(today, complete));
    const august = forecast.months.find((book) => book.month === '2026-08')!;
    // The two large purchases, less nothing: the small refund falls outside the February one-off's 90 days.
    assert.equal(august.oneOffsMinor, 900_000 + 750_000);
    assert.equal(forecast.pace.oneOffsMinor, 900_000 + 750_000);
  });
});

describe('what never moves a baseline', () => {
  const months = monthsFrom('2025-08', 14);
  const today = '2026-10-20';
  const complete = months.slice(0, 14);
  /** Small everyday purchases only (well under the $500 floor for one-offs), so the threshold is the floor. */
  function everyday(): CardForecastRow[] {
    const next = seededRandom(5);
    const rows: CardForecastRow[] = [];
    for (const month of [...months, '2026-10']) {
      const days = month === '2026-10' ? 20 : daysIn(month);
      for (let index = 0; index < 22; index += 1) {
        const merchant = index % 3 === 0 ? ['SAMPLE BISTRO', RESTAURANT] : ['SAMPLE GROCER #0012', GROCERIES];
        rows.push(tx(day(month, 1 + Math.floor(next() * days)), 500 + Math.floor(next() * 11_500), merchant[0], { issuerCategory: merchant[1] }));
      }
    }
    return rows;
  }
  const baseline = (rows: readonly CardForecastRow[], extra: Partial<CardSpendingForecastInput> = {}, fitted: readonly string[] = complete) => {
    const forecast = forecastCardSpending(rows, input(today, fitted, extra));
    const patterns = cardSpendingPatterns(rows, input(today, fitted, extra));
    const { pace } = forecast;
    return {
      total: forecast.total,
      categories: forecast.categories,
      everyday: forecast.months.map((book) => [book.month, book.everydayMinor]),
      pace: [pace.restMinor, pace.typicalMinor, pace.historyMonths, pace.everydaySpentMinor, pace.everydayProjectedMinor, pace.everydayRange80],
      anomalies: patterns.anomalies,
      checks: patterns.checks,
    };
  };

  it('a large one-off: neither its presence, its size nor its refund', () => {
    const base = everyday();
    const without = baseline(base);
    const plain = forecastCardSpending(base, input(today, complete));
    assert.equal(plain.oneOffThresholdMinor, 50_000);
    for (const amount of [250_000, 2_500_000]) {
      const oneOffs = [
        tx('2026-06-14', amount, 'SAMPLE ELECTRONICS STORE', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' }),
        tx('2026-09-03', amount, 'SAMPLE AIRLINE TICKETS', { issuerCategory: 'Travel-Airline' }),
        tx('2026-10-02', amount, 'SAMPLE HOME GOODS', { issuerCategory: 'Merchandise & Supplies-Furnishing' }),
      ];
      const refund = tx('2026-07-01', -100_000, 'SAMPLE ELECTRONICS STORE', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' });
      for (const rows of [[...base, ...oneOffs], [...base, ...oneOffs, refund]]) {
        assert.deepEqual(baseline(rows), without);
        const forecast = forecastCardSpending(rows, input(today, complete));
        assert.equal(forecast.months.find((book) => book.month === '2026-09')!.oneOffsMinor, amount);
        // The fitted months hold June's and September's one-offs (October's is this month's), and July's refund.
        const refunded = rows.includes(refund) ? 100_000 : 0;
        assert.deepEqual(forecast.fit && [forecast.fit.oneOffPurchases, forecast.fit.oneOffPurchasesMinor, forecast.fit.oneOffRefundsMinor, forecast.fit.oneOffsMinor],
          [2, 2 * amount, refunded, 2 * amount - refunded]);
        // This month's one-off is spent and added to the month's total as posted; the everyday pace is the same.
        assert.equal(forecast.pace.oneOffsMinor, amount);
        assert.equal(forecast.pace.spentMinor, plain.pace.spentMinor + amount);
        assert.equal(forecast.pace.everydayProjectedMinor, plain.pace.everydayProjectedMinor);
        assert.equal(forecast.pace.projectedMinor, plain.pace.projectedMinor! + amount);
        assert.deepEqual(forecast.pace.projectedRange80, {
          lowerMinor: plain.pace.projectedRange80!.lowerMinor + amount,
          upperMinor: plain.pace.projectedRange80!.upperMinor + amount,
          coverage: plain.pace.projectedRange80!.coverage,
        });
      }
    }
  });

  it('months before the record is complete (a card in view starting later): never in a fit, a pace baseline or an anomaly window', () => {
    const next = seededRandom(13);
    const months = monthsFrom('2025-01', 22);
    const rows = months.flatMap((month) => {
      const days = month === '2026-10' ? 20 : daysIn(month);
      // Before August 2025 only one card has data: less is recorded, which says nothing about what was spent.
      const count = month < '2025-08' ? 6 : 18;
      return Array.from({ length: count }, () => tx(day(month, 1 + Math.floor(next() * days)), 800 + Math.floor(next() * 9_000), 'SAMPLE GROCER #0012', { issuerCategory: GROCERIES }));
    });
    const complete = months.filter((month) => month >= '2025-08' && month < '2026-10');
    const forecast = forecastCardSpending(rows, input('2026-10-20', complete));
    const patterns = cardSpendingPatterns(rows, input('2026-10-20', complete));
    assert.equal(forecast.fit!.from, '2025-08');
    assert.equal(forecast.pace.from! >= '2025-08', true);
    assert.ok(patterns.checks.every((check) => check.from === null || check.from >= '2025-08'));
    assert.deepEqual(forecast.months.filter((book) => book.month < '2025-08').map((book) => book.complete), [false, false, false, false, false, false, false]);
    // Whatever those months hold, every baseline is the same without them.
    const later = rows.filter((row) => row.transactionDate >= '2025-08-01');
    const strip = (result: ReturnType<typeof baseline>) => ({ ...result, everyday: result.everyday.filter(([month]) => (month as string) >= '2025-08') });
    assert.deepEqual(strip(baseline(rows, {}, complete)), strip(baseline(later, {}, complete)));
  });

  it('an asset purchase (precious metals, the owner\'s word) and its refund: nothing at all', () => {
    const ledger = syntheticSpendingLedger({ seed: 8, months: 20, start: '2025-01' });
    const complete20 = monthsFrom('2025-02', 18);
    const run = (rows: readonly CardForecastRow[]) => {
      const exclusions = resolveCardSpendingExclusions(rows);
      return {
        forecast: forecastCardSpending(rows, input('2026-08-17', complete20, { exclusions })),
        patterns: cardSpendingPatterns(rows, input('2026-08-17', complete20, { exclusions })),
      };
    };
    const metals = [
      tx('2026-03-09', 1_250_000, 'SAMPLEWAREHOUSE.COM *ONLINE', { cardAccountId: ledger.cards[0].id, userCategory: 'Precious metals' }),
      tx('2026-07-02', 640_000, 'SAMPLEWAREHOUSE.COM *ONLINE', { cardAccountId: ledger.cards[0].id, userCategory: 'Precious Metals' }),
      tx('2026-07-20', -640_000, 'SAMPLEWAREHOUSE.COM *ONLINE', { cardAccountId: ledger.cards[0].id, kind: 'refund' }),
      tx('2026-08-04', 90_000, 'SAMPLE BULLION EXCHANGE', { cardAccountId: ledger.cards[0].id, userCategory: 'precious metals' }),
    ];
    assert.deepEqual(run([...ledger.rows, ...metals]), run(ledger.rows));
  });

  it('a partial month: whatever it holds is never fitted, split or learned from', () => {
    const base = dailyGroceries(monthsFrom('2025-09', 14), 20);
    const partial = new Set(monthsFrom('2025-09', 13).filter((month) => month !== '2026-02'));
    const spike = Array.from({ length: 30 }, (_, index) => tx(day('2026-02', 1 + (index % 28)), 12_000 + index, 'SAMPLE BISTRO', { issuerCategory: RESTAURANT }));
    const plain = forecastCardSpending(base, input('2026-10-20', partial));
    const spiked = forecastCardSpending([...base, ...spike], input('2026-10-20', partial));
    assert.deepEqual(spiked.total, plain.total);
    assert.deepEqual(spiked.categories, plain.categories);
    assert.deepEqual(spiked.pace, plain.pace);
    assert.deepEqual(spiked.fit, plain.fit);
    assert.equal(spiked.oneOffThresholdMinor, plain.oneOffThresholdMinor);
    assert.deepEqual(spiked.months.find((book) => book.month === '2026-02'), {
      month: '2026-02', spendingMinor: 28_000 + 30 * 12_000 + 435, oneOffsMinor: null, everydayMinor: null, complete: false, inProgress: false,
    });
    assert.deepEqual(cardSpendingPatterns([...base, ...spike], input('2026-10-20', partial)).anomalies, cardSpendingPatterns(base, input('2026-10-20', partial)).anomalies);
  });
});

describe('the forecast', () => {
  it('needs three complete months, says how many there are, and forecasts the three months after this one', () => {
    const rows = dailyGroceries(monthsFrom('2026-07', 4), 22);
    const none = forecastCardSpending(rows, input('2026-10-22', []));
    assert.equal(none.fit, null);
    assert.equal(none.total, null);
    assert.deepEqual(none.categories, []);
    assert.deepEqual(none.horizon, ['2026-11', '2026-12', '2027-01']);
    const two = forecastCardSpending(rows, input('2026-10-22', ['2026-08', '2026-09']));
    assert.equal(two.total!.method, null);
    assert.equal(two.total!.historyMonths, 2);
    assert.deepEqual(two.total!.months, []);
    const three = forecastCardSpending(rows, input('2026-10-22', ['2026-07', '2026-08', '2026-09', '2026-10']));
    // The month in progress is never fitted, even when called complete.
    assert.equal(three.fit!.to, '2026-09');
    assert.equal(three.total!.method, 'median-run-rate');
    assert.equal(three.total!.tested, false);
    assert.deepEqual(three.total!.months.map((item) => [item.month, item.pointMinor, item.range80]), [
      ['2026-11', 31_000, null], ['2026-12', 31_000, null], ['2027-01', 31_000, null],
    ]);
  });

  it('a steady year: median run-rate, backtested on the last fifth, ranges once their coverage can be tested on ten months', () => {
    const months = monthsFrom('2025-08', 15);
    const rows = dailyGroceries(months, 15);
    const thirteen = forecastCardSpending(rows, input('2026-10-15', months.slice(1, 14))).total!;
    // Thirteen complete months: backtest errors from nine months (the fifth to the thirteenth). Each month's could be
    // tested only against a range from the other eight, which no range is made from: so no range at all.
    assert.equal(thirteen.tested, true);
    assert.equal(thirteen.backtest!.calibrationMonths, 9);
    assert.deepEqual([thirteen.backtest!.coverage80, thirteen.backtest!.coverage95], [{ inside: 0, tested: 0 }, { inside: 0, tested: 0 }]);
    assert.ok(thirteen.months.every((item) => item.range80 === null && item.range95 === null));
    const forecast = forecastCardSpending(rows, input('2026-10-15', months.slice(0, 14)));
    const total = forecast.total!;
    assert.equal(total.method, 'median-run-rate');
    assert.equal(total.tested, true);
    // The median of April to September 2026: 30 or 31 days of $10.
    assert.equal(total.months[0].pointMinor, 30_500);
    assert.deepEqual(total.backtest && [total.backtest.from, total.backtest.to, total.backtest.months, total.backtest.calibrationMonths], ['2026-07', '2026-09', 3, 10]);
    // Every month tested against the range the other nine give, and the ranges carry that coverage.
    assert.equal(total.backtest!.coverage80.tested, total.backtest!.calibrationForecasts);
    assert.ok(total.months.every((item) => item.range80 !== null && item.range80.lowerMinor <= item.pointMinor && item.range80.upperMinor >= item.pointMinor
      && item.range80.coverage.tested === total.backtest!.coverage80.tested && item.range80.coverage.inside === total.backtest!.coverage80.inside));
    assert.equal(total.months[0].range95!.basis, 'extended');
    assert.deepEqual(total.months[0].range95!.coverage, total.backtest!.coverage95);
    assert.equal(total.thin, false);
    assert.deepEqual(forecast.categories.map((item) => item.category), [GROCERIES]);
    // One category with all the spending: its forecast is the total's.
    assert.deepEqual({ ...forecast.categories[0], category: null }, total);
  });

  it('counts each complete month\'s categories exactly as the summary does for the same rows, split parts included', () => {
    const months = monthsFrom('2025-10', 13);
    const next = seededRandom(17);
    const kinds: Array<[string, Partial<CardForecastRow>]> = [
      ['SAMPLE BISTRO', { issuerCategory: RESTAURANT }],
      ['SAMPLE GROCER #0012', { issuerCategory: GROCERIES }],
      ['SAMPLE DOVETAIL', { inferredCategory: 'Home' }],
    ];
    const rows: CardForecastRow[] = [];
    for (const month of months) {
      const days = month === '2026-10' ? 15 : daysIn(month);
      for (let index = 0; index < 9; index += 1) {
        const [description, extra] = kinds[index % 3];
        rows.push(tx(day(month, 1 + Math.floor(next() * days)), 800 + Math.floor(next() * 6_000), description, extra));
      }
      rows.push(tx(day(month, 14), -400 - Math.floor(next() * 300), 'SAMPLE GROCER #0012', { issuerCategory: GROCERIES }));
    }
    // A row split by its order's items: its parts' categories, not its own.
    const split = tx('2026-04-08', 4_000, 'SAMPLE MARKETPLACE', { issuerCategory: 'Merchandise & Supplies-Internet Purchase' });
    rows.push(split);
    const categoryParts = new Map([[split.id!, [{ category: 'Home', amountMinor: 2_500 }, { category: 'Books', amountMinor: 1_500 }]]]);
    const complete = months.slice(0, 12);
    const series = readCardSpendingSeries(rows, input('2026-10-15', complete, { categoryParts }));
    assert.equal(forecastCardSpending(rows, input('2026-10-15', complete, { categoryParts })).fit!.oneOffPurchases, 0);
    series.months.forEach((month, index) => {
      const summary = summarizeCardSpending(rows.filter((row) => row.transactionDate.startsWith(month)), { categoryParts });
      const byCategory = new Map(summary.byCategory.map((item) => [item.category, item.spendingMinor]));
      const names = new Set([...byCategory.keys(), ...series.categories.keys()]);
      for (const category of names) {
        assert.equal(series.categories.get(category)?.[index] ?? 0, byCategory.get(category) ?? 0, `${month} ${category}`);
      }
    });
  });

  it('counts the fitted months\' one-offs and the refunds set against them: one refunded in full nets to nothing, yet is there', () => {
    const months = monthsFrom('2025-10', 13);
    const rows = [
      ...dailyGroceries(months, 15),
      tx('2026-03-04', 100_000, 'SAMPLE TV SHOP', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' }),
      tx('2026-03-20', -100_000, 'SAMPLE TV SHOP', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' }),
    ];
    const forecast = forecastCardSpending(rows, input('2026-10-15', months.slice(0, 12)));
    assert.deepEqual(forecast.fit && [forecast.fit.oneOffPurchases, forecast.fit.oneOffPurchasesMinor, forecast.fit.oneOffRefundsMinor, forecast.fit.oneOffsMinor],
      [1, 100_000, 100_000, 0]);
    const march = forecast.months.find((book) => book.month === '2026-03')!;
    assert.deepEqual([march.spendingMinor, march.oneOffsMinor, march.everydayMinor], [31_000, 0, 31_000]);
  });

  it('marks thin categories: few months, or spending in fewer than half of them', () => {
    const months = monthsFrom('2025-10', 12);
    const rows = [
      ...dailyGroceries(months),
      ...months.filter((_, index) => index % 4 === 0).map((month) => tx(day(month, 9), 30_000, 'SAMPLE AIRLINE TICKETS', { issuerCategory: 'Travel-Airline' })),
    ];
    const forecast = forecastCardSpending(rows, input('2026-10-20', months));
    assert.deepEqual(forecast.categories.map((item) => [item.category, item.thin]), [[GROCERIES, false], ['Travel-Airline', true]]);
    const short = forecastCardSpending(rows, input('2026-10-20', months.slice(-5)));
    assert.ok(short.categories.every((item) => item.thin));
  });

  it('is deterministic', () => {
    const ledger = syntheticSpendingLedger({ seed: 21, months: 30, start: '2024-03' });
    const run = () => forecastCardSpending(ledger.rows, input('2026-08-20', monthsFrom('2024-05', 27)));
    assert.deepEqual(run(), run());
  });

  it('refuses a malformed today', () => {
    assert.throws(() => forecastCardSpending([], input('2026-02-30', [])), RangeError);
    assert.throws(() => cardSpendingPatterns([], input('20261022', [])), RangeError);
  });
});

describe('this month\'s pace', () => {
  const months = monthsFrom('2025-10', 13);

  it('everyday spending so far plus the typical rest of the month, scaled to the days left; the month\'s total adds this month\'s one-offs as posted', () => {
    const rows = [
      ...dailyGroceries(months, 15),
      tx('2026-10-03', 300_000, 'SAMPLE ELECTRONICS STORE', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' }),
      tx('2026-10-14', 2_500, 'SAMPLE BISTRO', { status: 'pending', issuerCategory: RESTAURANT }),
      tx('2026-10-05', 500_000, 'SAMPLE BULLION EXCHANGE', { userCategory: 'Precious metals' }),
    ];
    const pace = forecastCardSpending(rows, input('2026-10-15', months.slice(0, 12), { monthSoFarComplete: true })).pace;
    // October has 16 days left. September's 15 after the 15th give 16/15 of $150, February's 13 give 16/13 of $130: $160.
    // A typical month: the median of the twelve months' everyday spending, $310. Each month's rest falls inside the
    // range the other eleven give.
    assert.deepEqual(pace, {
      month: '2026-10', daysElapsed: 15, daysInMonth: 31,
      spentMinor: 15_000 + 300_000, everydaySpentMinor: 15_000, oneOffsMinor: 300_000, pendingMinor: 2_500, monthSoFarComplete: true,
      historyMonths: 12, from: '2025-10', to: '2026-09',
      restMinor: 16_000, typicalMinor: 31_000,
      everydayProjectedMinor: 15_000 + 16_000,
      everydayRange80: { lowerMinor: 31_000, upperMinor: 31_000, coverage: { inside: 12, tested: 12 } },
      projectedMinor: 15_000 + 16_000 + 300_000,
      projectedRange80: { lowerMinor: 331_000, upperMinor: 331_000, coverage: { inside: 12, tested: 12 } },
    });
  });

  it('gives no range below ten months (each tested against the other nine), and no estimate below three', () => {
    const rows = dailyGroceries(months, 15);
    const five = forecastCardSpending(rows, input('2026-10-15', months.slice(7, 12))).pace;
    assert.equal(five.historyMonths, 5);
    assert.deepEqual([five.restMinor, five.everydayProjectedMinor, five.everydayRange80, five.projectedRange80], [16_000, 31_000, null, null]);
    const nine = forecastCardSpending(rows, input('2026-10-15', months.slice(3, 12))).pace;
    assert.deepEqual([nine.historyMonths, nine.everydayRange80, nine.projectedRange80], [9, null, null]);
    const ten = forecastCardSpending(rows, input('2026-10-15', months.slice(2, 12))).pace;
    assert.equal(ten.historyMonths, 10);
    assert.deepEqual(ten.everydayRange80, { lowerMinor: 31_000, upperMinor: 31_000, coverage: { inside: 10, tested: 10 } });
    const two = forecastCardSpending(rows, input('2026-10-15', months.slice(10, 12))).pace;
    assert.deepEqual([two.restMinor, two.typicalMinor, two.everydayProjectedMinor, two.projectedMinor, two.monthSoFarComplete], [null, null, null, null, null]);
    assert.equal(two.spentMinor, 15_000);
  });

  it('a one-off this month moves the month\'s total by exactly its amount, and the everyday pace not at all', () => {
    const rows = dailyGroceries(months, 15);
    const plain = forecastCardSpending(rows, input('2026-10-15', months.slice(0, 12))).pace;
    const big = forecastCardSpending([...rows, tx('2026-10-10', 5_000_000, 'SAMPLE UNIQUE LARGE')], input('2026-10-15', months.slice(0, 12))).pace;
    assert.deepEqual(
      [big.everydaySpentMinor, big.restMinor, big.typicalMinor, big.everydayProjectedMinor, big.everydayRange80],
      [plain.everydaySpentMinor, plain.restMinor, plain.typicalMinor, plain.everydayProjectedMinor, plain.everydayRange80],
    );
    assert.deepEqual([big.oneOffsMinor, big.spentMinor - plain.spentMinor, big.projectedMinor! - plain.projectedMinor!], [5_000_000, 5_000_000, 5_000_000]);
    assert.deepEqual(big.projectedRange80, {
      lowerMinor: plain.projectedRange80!.lowerMinor + 5_000_000, upperMinor: plain.projectedRange80!.upperMinor + 5_000_000, coverage: plain.projectedRange80!.coverage,
    });
  });

  it('on the last day of the month, the rest is nothing', () => {
    const rows = dailyGroceries(months, 31);
    const pace = forecastCardSpending(rows, input('2026-10-31', months.slice(0, 12))).pace;
    assert.deepEqual([pace.restMinor, pace.everydayProjectedMinor, pace.projectedMinor, pace.historyMonths], [0, 31_000, 31_000, 12]);
  });

  it('its 80% range holds the month within 10 points of 80% on simulated months', () => {
    let inside = 0;
    let total = 0;
    for (const seed of [1, 2, 3]) {
      const next = seededRandom(seed);
      for (let run = 0; run < 70; run += 1) {
        const rows: CardForecastRow[] = [];
        for (const month of months) {
          for (let date = 1; date <= daysIn(month); date += 1) {
            if (next() < 0.6) {
              const normal = Math.sqrt(-2 * Math.log(Math.max(next(), 1e-12))) * Math.cos(2 * Math.PI * next());
              rows.push(tx(day(month, date), Math.round(3_000 * Math.exp(0.4 * normal)), 'SAMPLE GROCER #0012', { issuerCategory: GROCERIES }));
            }
          }
        }
        const pace = forecastCardSpending(rows, input('2026-10-10', months.slice(0, 12))).pace;
        const actual = rows.filter((row) => row.transactionDate.startsWith('2026-10')).reduce((sum, row) => sum + row.amountMinor, 0);
        total += 1;
        if (actual >= pace.projectedRange80!.lowerMinor && actual <= pace.projectedRange80!.upperMinor) inside += 1;
      }
    }
    const coverage = (100 * inside) / total;
    assert.ok(Math.abs(coverage - 80) <= 10, `${coverage.toFixed(1)}% is not within 10 points of 80%`);
  });
});

describe('unusual spending', () => {
  const months = monthsFrom('2025-10', 13);
  /** Groceries around $400 and a bistro around $150 every month; then September 2026 as given. */
  function history(september: { groceries: number; bistro: number; travel?: number }): CardForecastRow[] {
    const rows: CardForecastRow[] = [];
    months.slice(0, 12).forEach((month, index) => {
      const last = month === '2026-09';
      const groceries = last ? september.groceries : 4;
      for (let count = 0; count < groceries; count += 1) {
        rows.push(tx(day(month, 2 + count), 9_800 + ((index * 37 + count * 11) % 450), 'SAMPLE GROCER #0012', { issuerCategory: GROCERIES }));
      }
      const bistro = last ? september.bistro : 1;
      for (let count = 0; count < bistro; count += 1) rows.push(tx(day(month, 18 + count), 15_000 + index * 10, 'SAMPLE BISTRO', { issuerCategory: RESTAURANT }));
      if (last && september.travel) rows.push(tx(day(month, 25), september.travel, 'SAMPLE TRAVEL DESK', { issuerCategory: 'Travel-Travel Agencies' }));
    });
    return rows;
  }

  it('flags the last complete month both ways, by more than 3 robust sigmas and at least $50', () => {
    const rows = [
      ...history({ groceries: 12, bistro: 1, travel: 30_000 }),
      tx('2026-09-11', 400_000, 'SAMPLE ELECTRONICS STORE', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' }),
    ];
    const patterns = cardSpendingPatterns(rows, input('2026-10-05', months.slice(0, 12)));
    assert.deepEqual(patterns.checks, [{ window: 'month', month: '2026-09', checked: true, historyMonths: 11, from: '2025-10', to: '2026-08' }]);
    const flagged = patterns.anomalies.map((item) => [item.category, item.direction, item.thin, item.z === null]);
    // Everyday spending and groceries ran high; a category with nothing in the eleven months before is thin, with no z.
    // The one-off electronics purchase is no anomaly: it is in no baseline.
    assert.deepEqual(flagged, [[null, 'high', false, false], [GROCERIES, 'high', false, false], ['Travel-Travel Agencies', 'high', true, true]]);
    const groceries = patterns.anomalies.find((item) => item.category === GROCERIES)!;
    assert.equal(groceries.amountMinor > 100_000, true);
    assert.ok(groceries.z! > 3);
    const low = cardSpendingPatterns(history({ groceries: 1, bistro: 1 }), input('2026-10-05', months.slice(0, 12)));
    assert.deepEqual(low.anomalies.filter((item) => item.category === GROCERIES).map((item) => item.direction), ['low']);
  });

  it('never compares the month in progress, whatever is known of its record', () => {
    const rows = [
      ...history({ groceries: 4, bistro: 1 }),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((date) => tx(day('2026-10', date), 15_000, 'SAMPLE BISTRO', { issuerCategory: RESTAURANT })),
    ];
    for (const monthSoFarComplete of [true, false, null, undefined]) {
      const patterns = cardSpendingPatterns(rows, input('2026-10-25', months.slice(0, 12), monthSoFarComplete === undefined ? {} : { monthSoFarComplete }));
      assert.deepEqual(patterns.checks.map((item) => [item.window, item.month, item.checked]), [['month', '2026-09', true]]);
      assert.ok(patterns.anomalies.every((item) => item.month === '2026-09'));
    }
  });

  it('needs six complete months before the month it checks', () => {
    const patterns = cardSpendingPatterns(history({ groceries: 12, bistro: 1 }), input('2026-10-20', months.slice(6, 12)));
    assert.deepEqual(patterns.checks.map((item) => [item.window, item.checked, item.historyMonths]), [['month', false, 5]]);
    assert.deepEqual(patterns.anomalies, []);
  });
});

describe('the bills calendar', () => {
  const today = '2026-10-22';
  const rows = [
    ...monthsFrom('2026-04', 7).map((month) => tx(day(month, 5), 1_599, 'SAMPLE STREAMING', { issuerCategory: 'Entertainment-Other Entertainment' })),
    ...['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']
      .map((date) => tx(date, 2_000, 'SAMPLE YOGA STUDIO')),
    ...monthsFrom('2026-05', 5).map((month) => tx(day(month, 20), 4_500, 'SAMPLE GYM CLUB', { cardAccountId: 'card-b' })),
  ];
  const bills = cardSpendingPatterns(rows, input(today, [])).bills;

  it('lists each active charge\'s expected days in the next 60, the overdue one first, never late without a complete month', () => {
    assert.equal(bills.activeCharges, 3);
    assert.deepEqual([bills.from, bills.to], ['2026-10-22', '2026-12-21']);
    assert.deepEqual(bills.items.filter((item) => item.merchant !== 'SAMPLE YOGA STUDIO').map((item) => [item.date, item.merchant, item.amountMinor, item.expectedBeforeToday, item.late]), [
      ['2026-10-20', 'SAMPLE GYM CLUB', 4_500, true, false],
      ['2026-11-04', 'SAMPLE STREAMING', 1_599, false, false],
      ['2026-11-19', 'SAMPLE GYM CLUB', 4_500, false, false],
      ['2026-12-04', 'SAMPLE STREAMING', 1_599, false, false],
      ['2026-12-19', 'SAMPLE GYM CLUB', 4_500, false, false],
    ]);
    assert.deepEqual(bills.items.filter((item) => item.merchant === 'SAMPLE YOGA STUDIO').map((item) => item.date), [
      '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21',
    ]);
    // Each says what shows it bills: its charges, and the months of the first and the last.
    assert.deepEqual([...new Map(bills.items.map((item) => [item.merchant, item.evidence])).entries()].sort(), [
      ['SAMPLE GYM CLUB', { occurrences: 5, from: '2026-05', to: '2026-09' }],
      ['SAMPLE STREAMING', { occurrences: 7, from: '2026-04', to: '2026-10' }],
      ['SAMPLE YOGA STUDIO', { occurrences: 8, from: '2026-08', to: '2026-10' }],
    ]);
  });

  it('a bill is late only when its expected day is in a complete month; partial months still show it bills', () => {
    const streaming = ['2026-05-01', '2026-06-01', '2026-07-01'].map((date) => tx(date, 1_599, 'SAMPLE STREAMING', { issuerCategory: 'Entertainment-Other Entertainment' }));
    const due = (completeMonths: string[]) => cardSpendingPatterns(streaming, input('2026-08-04', completeMonths)).bills.items
      .filter((item) => item.date < '2026-08-04').map((item) => [item.date, item.expectedBeforeToday, item.late, item.evidence]);
    const evidence = { occurrences: 3, from: '2026-05', to: '2026-07' };
    // Learned from rows of months that are not complete: it bills, and July 31 has passed without a charge.
    assert.deepEqual(due([]), [['2026-07-31', true, false, evidence]]);
    assert.deepEqual(due(['2026-05', '2026-06']), [['2026-07-31', true, false, evidence]]);
    // With July's record complete, a charge missing from it is late.
    assert.deepEqual(due(['2026-05', '2026-06', '2026-07']), [['2026-07-31', true, true, evidence]]);
    // Expected earlier this month: never late, whatever the months before.
    const second = ['2026-05-02', '2026-06-02', '2026-07-02'].map((date) => tx(date, 899, 'SAMPLE NEWS DAILY', { issuerCategory: 'Entertainment-Other Entertainment' }));
    const thisMonth = cardSpendingPatterns(second, input('2026-08-04', ['2026-05', '2026-06', '2026-07'], { monthSoFarComplete: true })).bills.items;
    assert.deepEqual(thisMonth.filter((item) => item.date < '2026-08-04').map((item) => [item.date, item.expectedBeforeToday, item.late]), [['2026-08-01', true, false]]);
  });

  it('adds up: the calendar and this month are the sums of their bills', () => {
    assert.equal(bills.count, bills.items.length);
    assert.equal(bills.totalMinor, bills.items.reduce((sum, item) => sum + item.amountMinor, 0));
    const due = bills.items.filter((item) => item.date <= '2026-10-31');
    assert.equal(bills.thisMonth.dueMinor, due.reduce((sum, item) => sum + item.amountMinor, 0));
    // Due: the gym's late charge and the next yoga class. Charged so far: the streaming bill and three classes.
    assert.deepEqual(bills.thisMonth, {
      through: '2026-10-31', dueCount: 2, dueMinor: 4_500 + 2_000, chargedCount: 4, chargedMinor: 1_599 + 3 * 2_000,
    });
  });

  it('leaves out stopped charges and asset purchases', () => {
    const stopped = cardSpendingPatterns(rows, input('2027-01-30', [])).bills;
    assert.equal(stopped.activeCharges, 0);
    assert.deepEqual(stopped.items, []);
    const metals = monthsFrom('2026-05', 6).map((month) => tx(day(month, 2), 50_000, 'SAMPLE BULLION EXCHANGE', { userCategory: 'Precious metals' }));
    assert.deepEqual(cardSpendingPatterns([...rows, ...metals], input(today, [])).bills, bills);
  });
});

describe('thresholds', () => {
  it('are named constants', () => {
    assert.equal(CARD_SPENDING_FORECAST.horizonMonths, 3);
    assert.equal(CARD_SPENDING_FORECAST.anomalyZ, 3);
    assert.equal(CARD_SPENDING_FORECAST.anomalyMinMonths, 6);
    assert.equal(CARD_SPENDING_FORECAST.billsDays, 60);
  });
});
