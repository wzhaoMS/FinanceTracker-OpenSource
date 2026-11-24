import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_SPENDING_STATS,
  backtestMetrics,
  backtestSeries,
  calibratedRange,
  empiricalRange,
  forecastSeries,
  forecastSpendingSeries,
  leaveOneOutCoverage,
  maseScale,
  median,
  medianAbsoluteDeviation,
  rangeMinValues,
  rangeRanks,
  robustSpread,
  type SpendingSeries,
} from './cardSpendingStats.js';

// Synthetic series only: made-up numbers with answers worked out by hand, and simulated noise from a seeded generator.

/** mulberry32: a small seeded generator, so every simulated series is the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A standard normal draw (Box-Muller). */
function normal(next: () => number): number {
  const u = Math.max(next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

const close = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

describe('robust statistics', () => {
  it('takes the median of odd and even counts', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.ok(Number.isNaN(median([])));
  });

  it('estimates sigma from the MAD, untouched by one huge month', () => {
    assert.equal(medianAbsoluteDeviation([1, 2, 3, 4, 100]), 1);
    const spread = robustSpread([1, 2, 3, 4, 100]);
    assert.deepEqual(spread, { median: 3, sigma: 1.4826, basis: 'mad' });
    assert.deepEqual(robustSpread([1, 2, 3, 4, 1_000_000_000]), spread);
  });

  it('falls back to the mean absolute deviation when the MAD is 0, and says when every value is equal', () => {
    const spread = robustSpread([5, 5, 5, 5, 9]);
    assert.equal(spread.basis, 'mean-absolute-deviation');
    close(spread.sigma, 1.2533 * 0.8);
    assert.deepEqual(robustSpread([7, 7, 7]), { median: 7, sigma: 0, basis: 'none' });
    assert.throws(() => robustSpread([]), RangeError);
  });
});

describe('ranges at finite-sample ranks', () => {
  it('needs 9 values for an 80% range and 39 for a 95% one of its own', () => {
    assert.equal(rangeRanks(8, 80), null);
    assert.deepEqual(rangeRanks(9, 80), { lower: 1, upper: 9 });
    assert.deepEqual(rangeRanks(12, 80), { lower: 1, upper: 12 });
    assert.deepEqual(rangeRanks(19, 80), { lower: 2, upper: 18 });
    assert.deepEqual(rangeRanks(29, 80), { lower: 3, upper: 27 });
    assert.equal(rangeRanks(38, 95), null);
    assert.deepEqual(rangeRanks(39, 95), { lower: 1, upper: 39 });
    assert.equal(rangeMinValues(80), 9);
    assert.equal(rangeMinValues(95), 39);
  });

  it('takes the values at those ranks, and widens the 80% range for 95% while there are too few values', () => {
    const values = Array.from({ length: 19 }, (_, index) => 19 - index);
    assert.deepEqual(empiricalRange(values, 80), { lower: 2, upper: 18, basis: 'empirical' });
    const wide = empiricalRange(values, 95)!;
    assert.equal(wide.basis, 'extended');
    close(wide.lower, 10 - 8 * CARD_SPENDING_STATS.rangeExtension);
    close(wide.upper, 10 + 8 * CARD_SPENDING_STATS.rangeExtension);
    close(CARD_SPENDING_STATS.rangeExtension, 1.5294, 1e-4);
    assert.equal(empiricalRange([1, 2, 3, 4, 5, 6, 7, 8], 80), null);
    assert.equal(empiricalRange([1, 2, 3, 4, 5, 6, 7, 8], 95), null);
    const many = Array.from({ length: 39 }, (_, index) => index);
    assert.deepEqual(empiricalRange(many, 95), { lower: 0, upper: 38, basis: 'empirical' });
  });

  it('scores coverage leave-one-out: a value is never judged by a range made from itself', () => {
    // Each of 1..10 against the range of the other nine (their minimum to maximum): only 1 and 10 fall outside.
    assert.deepEqual(leaveOneOutCoverage([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 80), { inside: 8, tested: 10 });
    assert.deepEqual(leaveOneOutCoverage([1, 2, 3, 4, 5, 6, 7, 8, 9], 80), { inside: 0, tested: 0 });
  });
});

describe('forecasting methods', () => {
  it('median run-rate: the median of the last six known months, needing three', () => {
    assert.deepEqual(forecastSeries('median-run-rate', [10, 20, 30, 40, 50, 60, 70], [1, 2]), [45, 45]);
    assert.deepEqual(forecastSeries('median-run-rate', [10, null, 30, null, 50], [1]), [30]);
    assert.equal(forecastSeries('median-run-rate', [10, null, 30], [1]), null);
  });

  it('seasonal naive: the same month in the latest year known before the origin', () => {
    const series = Array.from({ length: 24 }, (_, index) => 100 + (index % 12));
    assert.deepEqual(forecastSeries('seasonal-naive', series, [1, 2, 3, 13]), [100, 101, 102, 100]);
    const gap: SpendingSeries = series.map((value, index) => (index === 12 ? null : value + (index >= 12 ? 50 : 0)));
    // Month 12 (a January) is unknown: its forecast comes from the January a year earlier.
    assert.deepEqual(forecastSeries('seasonal-naive', gap, [1, 2]), [100, 151]);
    assert.equal(forecastSeries('seasonal-naive', series.slice(0, 11), [1]), null);
  });

  it('damped ETS follows a trend and damps it', () => {
    const line = Array.from({ length: 24 }, (_, index) => 1000 + 50 * index);
    const [first, second, third] = forecastSeries('ets-damped', line, [1, 2, 3])!;
    close(first, 1000 + 50 * 24, 15);
    assert.ok(second > first && third > second);
    assert.ok(third - second < 50 && second - first < 50, 'the trend is damped');
    assert.ok(first > forecastSeries('median-run-rate', line, [1])![0]);
    assert.equal(forecastSeries('ets-damped', line.slice(0, 11), [1]), null);
  });

  it('damped Holt-Winters recovers a seasonal pattern on a trend, and needs two full known years', () => {
    const truth = (index: number) => 2000 + 5 * index + 400 * Math.sin((2 * Math.PI * index) / 12);
    const series = Array.from({ length: 36 }, (_, index) => truth(index));
    const points = forecastSeries('holt-winters-damped', series, [1, 2, 3])!;
    points.forEach((point, index) => close(point, truth(36 + index), 0.03 * truth(36 + index)));
    assert.equal(forecastSeries('holt-winters-damped', series.slice(0, 23), [1]), null);
    assert.equal(forecastSeries('holt-winters-damped', series.map((value, index) => (index === 5 ? null : value)), [1]), null);
  });

  it('refuses offsets that are not whole months ahead', () => {
    assert.throws(() => forecastSeries('median-run-rate', [1, 2, 3], [0]), RangeError);
    assert.throws(() => forecastSeries('median-run-rate', [1, 2, 3], [1.5]), RangeError);
  });
});

describe('backtests', () => {
  // Twelve months of 10, a one-off month of 40, then 10 again: the last fifth (at least three) is months 12 to 14.
  const spike: SpendingSeries = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 40, 10, 10];

  it('forecasts each of the last fifth of known months from before it, and reproduces hand-worked metrics', () => {
    const backtest = backtestSeries(spike, 'median-run-rate', [1])!;
    assert.deepEqual(backtest.targets, [12, 13, 14]);
    assert.deepEqual(backtest.origins, [11, 12, 13]);
    // Every forecast is the median of six months, which the spike never moves: 10. Errors: 30, 0, 0.
    assert.deepEqual(backtest.errors.map((item) => [item.target, item.forecast, item.error]), [[12, 10, 30], [13, 10, 0], [14, 10, 0]]);
    // Ranges calibrate on every month the method could forecast: from three known months on, months 3 to 14.
    assert.deepEqual(backtest.calibration.map((item) => item.target), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    assert.deepEqual(backtest.calibration.map((item) => item.error), [0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 0, 0]);
    const metrics = backtestMetrics(spike, backtest, { nearZero: 5 });
    assert.equal(metrics.mae, 10);
    assert.equal(metrics.bias, 10);
    // Same-month pairs (12,0), (13,1), (14,2): |40-10|, 0, 0, so the seasonal naive's in-sample MAE is 10.
    assert.deepEqual(maseScale(spike), { scale: 10, benchmark: 'seasonal-naive' });
    assert.equal(metrics.mase, 1);
    assert.equal(metrics.maseBenchmark, 'seasonal-naive');
    // (30/40 + 0 + 0) / 3 = 25%.
    assert.equal(metrics.mape, 25);
    assert.equal(metrics.mapeErrors, 3);
    assert.equal(metrics.calibrationMonths, 12);
    // Leaving one month out: the spike's month meets a range of [0, 0] from the eleven others and falls outside; every
    // other month meets [0, 30] (95%: widened to [0, 45.9]) and falls inside.
    assert.deepEqual(metrics.coverage80, { inside: 11, tested: 12 });
    assert.deepEqual(metrics.coverage95, { inside: 11, tested: 12 });
    assert.deepEqual(calibratedRange(backtest.calibration, 80), { lower: 0, upper: 30, basis: 'empirical' });
  });

  it('leaves near-zero actuals out of MAPE, and scales MASE by the naive below three same-month pairs', () => {
    const series: SpendingSeries = [0, 100, 0, 100, 0, 100, 0, 100];
    const backtest = backtestSeries(series, 'median-run-rate', [1])!;
    assert.deepEqual(backtest.targets, [5, 6, 7]);
    // Medians of months 0-4 [0,100,0,100,0], 0-5 [0,100,0,100,0,100] and 1-6 [100,0,100,0,100,0]: 0, 50 and 50.
    assert.deepEqual(backtest.errors.map((item) => item.error), [100, -50, 50]);
    const metrics = backtestMetrics(series, backtest, { nearZero: 50 });
    // No same-month pair yet: the naive's in-sample error, |100 - 0| every month.
    assert.deepEqual(maseScale(series), { scale: 100, benchmark: 'naive' });
    close(metrics.mase!, 200 / 3 / 100);
    assert.equal(metrics.maseBenchmark, 'naive');
    // Only the two actuals of 100 count: errors of 100 and 50 on 100, so 75%.
    assert.equal(metrics.mapeErrors, 2);
    assert.equal(metrics.mape, 75);
  });

  it('has no MASE for a series that never changed', () => {
    const flat = [5, 5, 5, 5, 5, 5];
    const metrics = backtestMetrics(flat, backtestSeries(flat, 'median-run-rate', [1])!, { nearZero: 1 });
    assert.equal(metrics.mae, 0);
    assert.equal(metrics.mase, null);
    assert.equal(metrics.maseBenchmark, null);
  });

  it('forecasts every target from each offset, grouping origins', () => {
    const series = Array.from({ length: 12 }, (_, index) => 100 + index);
    const backtest = backtestSeries(series, 'median-run-rate', [2, 3, 4])!;
    assert.deepEqual(backtest.targets, [9, 10, 11]);
    assert.deepEqual(backtest.origins, [5, 6, 7, 8, 9]);
    assert.equal(backtest.errors.length, 9);
    // Target 9 from origin 7 (offset 2): the median of months 2 to 7 (102..107) is 104.5.
    assert.deepEqual(backtest.errors[0], { target: 9, offset: 2, actual: 109, forecast: 104.5, error: 4.5 });
    // Calibration: origins 2 to 9 reach months 4 to 11, 21 forecasts in all.
    assert.equal(backtest.calibration.length, 21);
    assert.deepEqual([...new Set(backtest.calibration.map((item) => item.target))], [4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('cannot test a method without enough history before every origin', () => {
    assert.equal(backtestSeries(Array.from({ length: 12 }, () => 5), 'seasonal-naive', [1]), null);
    assert.equal(backtestSeries([1, 2, 3, 4, 5], 'median-run-rate', [1]), null);
    assert.equal(backtestSeries([1, 2, 3], 'median-run-rate', [1]), null);
  });

  it('skips unknown months as targets and as history', () => {
    const series: SpendingSeries = [10, 10, null, 10, 10, 10, 10, null, 10, 12, 14];
    const backtest = backtestSeries(series, 'median-run-rate', [1])!;
    assert.deepEqual(backtest.targets, [8, 9, 10]);
    assert.deepEqual(backtest.errors.map((item) => item.error), [0, 2, 4]);
  });
});

describe('the forecast of one series', () => {
  it('gives no forecast below three known months, and an untested point without a range when it cannot be backtested', () => {
    const none = forecastSpendingSeries([100, null, 120], [1, 2, 3], { nearZero: 50 });
    assert.equal(none.method, null);
    assert.equal(none.history, 2);
    assert.deepEqual(none.forecasts, []);
    const untested = forecastSpendingSeries([100, 140, 120, 90, 110], [1, 2, 3], { nearZero: 50 });
    assert.equal(untested.method, 'median-run-rate');
    assert.equal(untested.tested, false);
    assert.equal(untested.backtest, null);
    assert.deepEqual(untested.forecasts.map((item) => [item.point, item.range80, item.range95]), [[110, null, null], [110, null, null], [110, null, null]]);
  });

  it('uses the median run-rate below a year, and steps down from seasonal naive until it can be backtested', () => {
    const series = Array.from({ length: 14 }, (_, index) => 100 + 10 * (index % 3));
    const forecast = forecastSpendingSeries(series, [2, 3, 4], { nearZero: 50 });
    assert.equal(forecast.method, 'median-run-rate');
    assert.equal(forecast.tested, true);
    assert.deepEqual(forecast.candidates, [{ method: 'seasonal-naive', mae: null }, { method: 'median-run-rate', mae: forecast.backtest!.mae }]);
    assert.equal(forecast.backtest!.errors, 9);
    assert.equal(forecast.backtest!.calibrationMonths, 10);
    assert.ok(forecast.forecasts.every((item) => item.range80 !== null && item.range95?.basis === 'extended'));
  });

  it('gives a tested forecast no range until its coverage can be tested on ten months', () => {
    const forecast = forecastSpendingSeries([100, 140, 120, 90, 110, 130, 100, 120, 115], [2, 3, 4], { nearZero: 50 });
    assert.equal(forecast.method, 'median-run-rate');
    assert.equal(forecast.tested, true);
    assert.equal(forecast.backtest!.calibrationMonths, 5);
    assert.ok(forecast.forecasts.every((item) => item.range80 === null && item.range95 === null));
    // Thirteen months: errors from nine, enough to make a range but not to test one (each month against the other
    // eight, which make none). No range goes out untested.
    const thirteen = forecastSpendingSeries(Array.from({ length: 13 }, (_, index) => 10_000 + (index % 3) * 1_000), [2, 3, 4], { nearZero: 5_000 });
    assert.equal(thirteen.backtest!.calibrationMonths, 9);
    assert.deepEqual([thirteen.backtest!.coverage80, thirteen.backtest!.coverage95], [{ inside: 0, tested: 0 }, { inside: 0, tested: 0 }]);
    assert.ok(thirteen.forecasts.every((item) => item.range80 === null && item.range95 === null));
    // Twenty-two months on seasonal naive: nine months again, and no range; twenty-three give ten.
    const seasonal = (months: number) => forecastSpendingSeries(Array.from({ length: months }, (_, index) => 300 + 40 * (index % 12) + (index % 5)), [2, 3, 4], { nearZero: 50 });
    assert.deepEqual([seasonal(22).method, seasonal(22).backtest!.calibrationMonths, seasonal(22).forecasts[0].range80], ['seasonal-naive', 9, null]);
    assert.deepEqual([seasonal(23).method, seasonal(23).backtest!.calibrationMonths], ['seasonal-naive', 10]);
    assert.ok(seasonal(23).forecasts.every((item) => item.range80 !== null && item.range80.coverage.tested > 0));
  });

  it('every range it gives carries its tested coverage, from at least ten months', () => {
    const shapes: Array<(index: number) => number> = [
      (index) => 1000 + 37 * ((index * 7) % 11),
      (index) => 300 + 40 * (index % 12) + 9 * ((index * 5) % 7),
      (index) => (index % 4 === 0 ? 400 : 0),
      (index) => 500 + 12 * index + 30 * ((index * 3) % 5),
    ];
    let ranged = 0;
    for (const shape of shapes) {
      for (let months = 0; months <= 40; months += 1) {
        const series: SpendingSeries = Array.from({ length: months }, (_, index) => (index % 9 === 4 && months > 20 ? null : shape(index)));
        const forecast = forecastSpendingSeries(series, [2, 3, 4], { nearZero: 50 });
        for (const item of forecast.forecasts) {
          for (const [range, coverage] of [[item.range80, forecast.backtest?.coverage80], [item.range95, forecast.backtest?.coverage95]] as const) {
            if (!range) continue;
            ranged += 1;
            assert.ok(forecast.backtest && forecast.backtest.calibrationMonths >= CARD_SPENDING_STATS.rangeMinMonths, `${months} months`);
            assert.ok(range.coverage.tested > 0 && range.coverage.inside <= range.coverage.tested, `${months} months`);
            assert.deepEqual(range.coverage, coverage);
          }
        }
      }
    }
    assert.ok(ranged > 0);
  });

  it('uses seasonal naive from 12 known months once it can be backtested', () => {
    const series = Array.from({ length: 20 }, (_, index) => 100 + 30 * (index % 12 === 11 ? 1 : 0) + (index % 2));
    const forecast = forecastSpendingSeries(series, [1, 2, 3], { nearZero: 50 });
    assert.equal(forecast.method, 'seasonal-naive');
    assert.equal(forecast.backtest!.targets, 4);
  });

  it('with 24 or more months picks whichever backtests better: seasonal naive on a repeating year, damped ETS on a trend', () => {
    const pattern = [300, 280, 310, 330, 350, 420, 460, 440, 380, 340, 360, 520];
    const seasonal = forecastSpendingSeries(Array.from({ length: 30 }, (_, index) => pattern[index % 12]), [1, 2, 3], { nearZero: 50 });
    assert.equal(seasonal.method, 'seasonal-naive');
    assert.equal(seasonal.backtest!.mae, 0);
    assert.deepEqual(seasonal.forecasts.map((item) => item.point), [pattern[6], pattern[7], pattern[8]]);
    // Holt-Winters needs two full years before its earliest backtest origin, which 30 months do not give.
    assert.deepEqual(seasonal.candidates.map((item) => [item.method, item.mae === null]), [
      ['seasonal-naive', false], ['ets-damped', false], ['holt-winters-damped', true],
    ]);
    const trend = forecastSpendingSeries(Array.from({ length: 30 }, (_, index) => 500 + 20 * index), [1, 2, 3], { nearZero: 50 });
    assert.equal(trend.method, 'ets-damped');
    assert.ok(trend.backtest!.mae < trend.candidates[0].mae!);
  });

  it('never ranges below zero for a series that never went below zero', () => {
    const sporadic = Array.from({ length: 15 }, (_, index) => (index % 5 === 0 ? 400 : 0));
    const forecast = forecastSpendingSeries(sporadic, [1, 2, 3], { nearZero: 50 });
    assert.equal(forecast.method, 'median-run-rate');
    for (const item of forecast.forecasts) {
      assert.equal(item.point, 0);
      assert.ok(item.range80!.lower >= 0 && item.range95!.lower >= 0);
    }
  });

  it('is deterministic', () => {
    const series = Array.from({ length: 30 }, (_, index) => 1000 + 13 * index + (index % 4) * 70);
    assert.deepEqual(forecastSpendingSeries(series, [2, 3, 4], { nearZero: 50 }), forecastSpendingSeries(series, [2, 3, 4], { nearZero: 50 }));
  });
});

describe('range coverage on simulated data (within 10 points of the level)', () => {
  /**
   * Coverage of the 80% and 95% ranges for the months after many simulated series, each forecast from its own history
   * alone. Three seeds per scenario, so no single seed decides.
   */
  function simulate(options: {
    series: number; months: number; offsets: number[];
    draw: (next: () => number, month: number) => number;
  }) {
    const tally = { 80: { inside: 0, total: 0 }, 95: { inside: 0, total: 0 } };
    const methods = new Set<string>();
    for (const seed of [11, 23, 37]) {
      const next = random(seed);
      for (let run = 0; run < options.series; run += 1) {
        const all = Array.from({ length: options.months + Math.max(...options.offsets) }, (_, month) => options.draw(next, month));
        const forecast = forecastSpendingSeries(all.slice(0, options.months), options.offsets, { nearZero: 50 });
        if (forecast.method) methods.add(forecast.method);
        for (const item of forecast.forecasts) {
          const actual = all[options.months - 1 + item.offset];
          for (const level of [80, 95] as const) {
            const range = level === 80 ? item.range80 : item.range95;
            if (!range) continue;
            tally[level].total += 1;
            if (actual >= range.lower && actual <= range.upper) tally[level].inside += 1;
          }
        }
      }
    }
    assert.ok(tally[80].total > 0 && tally[95].total > 0, 'the scenario gives ranges');
    return { coverage80: tally[80].inside / tally[80].total, coverage95: tally[95].inside / tally[95].total, methods: [...methods].sort() };
  }

  const within = (result: { coverage80: number; coverage95: number }) => {
    for (const [coverage, level] of [[result.coverage80, 80], [result.coverage95, 95]] as const) {
      assert.ok(Math.abs(coverage * 100 - level) <= 10, `${(coverage * 100).toFixed(1)}% is not within 10 points of ${level}%`);
    }
  };
  const pattern = [300, 280, 310, 330, 350, 420, 460, 440, 380, 340, 360, 520];

  // From 14 known months: the first history whose backtest tests its ranges on ten months (13 gives none).
  for (const months of [14, 18, 24]) {
    it(`a steady month with normal noise, ${months} months of history`, () => {
      const result = simulate({ series: 200, months, offsets: [2, 3, 4], draw: (next) => 1000 + 150 * normal(next) });
      if (months < 24) assert.deepEqual(result.methods, ['median-run-rate']);
      within(result);
    });
  }

  it('a skewed month (lognormal), 18 months of history', () => {
    within(simulate({ series: 200, months: 18, offsets: [2, 3, 4], draw: (next) => 600 * Math.exp(0.35 * normal(next)) }));
  });

  it('a month that keeps growing, 18 months of history (the run-rate lags; its errors say so)', () => {
    within(simulate({ series: 200, months: 18, offsets: [2, 3, 4], draw: (next, month) => 800 + 15 * month + 120 * normal(next) }));
  });

  it('an occasional category: nothing most months, sometimes a purchase', () => {
    within(simulate({ series: 200, months: 15, offsets: [2, 3, 4], draw: (next) => (next() < 0.25 ? 200 + 300 * next() : 0) }));
  });

  it('a seasonal month with noise, 23 months of history (seasonal naive; 22 give no range yet)', () => {
    const result = simulate({ series: 200, months: 23, offsets: [2, 3, 4], draw: (next, month) => pattern[month % 12] + 25 * normal(next) });
    assert.deepEqual(result.methods, ['seasonal-naive']);
    within(result);
  });

  it('a seasonal month on a trend, 36 months of history (seasonal naive, damped ETS or damped Holt-Winters)', () => {
    const result = simulate({ series: 60, months: 36, offsets: [2, 3, 4], draw: (next, month) => pattern[month % 12] + 4 * month + 25 * normal(next) });
    assert.ok(result.methods.every((method) => method !== 'median-run-rate'));
    within(result);
  });
});
