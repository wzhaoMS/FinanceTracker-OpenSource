import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AMAZON_SPENDING_WINDOWS,
  amazonSpendingWindowRange,
  isAmazonSpendingDay,
  isAmazonSpendingWindow,
} from './amazonSpending.js';

const days = (range: { from: string; to: string }) =>
  Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1;

describe('Amazon spending windows', () => {
  it('are the five Alex asked for, in a fixed order, and nothing else', () => {
    assert.deepEqual([...AMAZON_SPENDING_WINDOWS], ['30D', '60D', 'YTD', '1Y', '2Y']);
    for (const key of AMAZON_SPENDING_WINDOWS) assert.equal(isAmazonSpendingWindow(key), true, key);
    for (const value of ['1D', '1M', '90D', '5Y', 'ALL', 'ytd', '1y', '', null, undefined, 30]) {
      assert.equal(isAmazonSpendingWindow(value), false, String(value));
    }
  });

  it('count calendar dates with today included, as Spending\'s periods do', () => {
    const today = '2026-10-21';
    assert.deepEqual(amazonSpendingWindowRange('30D', today), { from: '2026-09-22', to: today });
    assert.deepEqual(amazonSpendingWindowRange('60D', today), { from: '2026-08-23', to: today });
    assert.deepEqual(amazonSpendingWindowRange('YTD', today), { from: '2026-01-01', to: today });
    assert.deepEqual(amazonSpendingWindowRange('1Y', today), { from: '2025-10-22', to: today });
    assert.deepEqual(amazonSpendingWindowRange('2Y', today), { from: '2024-10-22', to: today });
    assert.equal(days(amazonSpendingWindowRange('30D', today)), 30);
    assert.equal(days(amazonSpendingWindowRange('60D', today)), 60);
    assert.equal(days(amazonSpendingWindowRange('1Y', today)), 365);
    // No February 29 falls between October 22, 2024 and October 21, 2026.
    assert.equal(days(amazonSpendingWindowRange('2Y', today)), 730);
  });

  it('never count a year twice over a leap day or a short month', () => {
    // A year ending on a leap day starts on March 1 (February 28 stands in for the 29th a year back): 366 days.
    assert.deepEqual(amazonSpendingWindowRange('1Y', '2024-02-29'), { from: '2023-03-01', to: '2024-02-29' });
    assert.equal(days(amazonSpendingWindowRange('1Y', '2024-02-29')), 366);
    assert.deepEqual(amazonSpendingWindowRange('2Y', '2024-02-29'), { from: '2022-03-01', to: '2024-02-29' });
    // The year to February 28, 2025 starts the day after February 28, 2024: the leap day, so 366 days again.
    assert.deepEqual(amazonSpendingWindowRange('1Y', '2025-02-28'), { from: '2024-02-29', to: '2025-02-28' });
    assert.equal(days(amazonSpendingWindowRange('1Y', '2025-02-28')), 366);
    // A year later the window starts on March 1 and holds 365 days: the windows a year apart never overlap.
    assert.deepEqual(amazonSpendingWindowRange('1Y', '2026-02-28'), { from: '2025-03-01', to: '2026-02-28' });
    assert.equal(days(amazonSpendingWindowRange('1Y', '2026-02-28')), 365);
    assert.deepEqual(amazonSpendingWindowRange('1Y', '2026-03-31'), { from: '2025-04-01', to: '2026-03-31' });
    assert.equal(days(amazonSpendingWindowRange('1Y', '2026-03-31')), 365);
  });

  it('start the year to date on January 1, and on New Year\'s Day hold that day alone', () => {
    assert.deepEqual(amazonSpendingWindowRange('YTD', '2026-01-01'), { from: '2026-01-01', to: '2026-01-01' });
    assert.deepEqual(amazonSpendingWindowRange('YTD', '2024-12-31'), { from: '2024-01-01', to: '2024-12-31' });
    assert.deepEqual(amazonSpendingWindowRange('30D', '2026-01-10'), { from: '2025-12-12', to: '2026-01-10' });
  });

  it('end only on a real calendar date from 1900 on, and refuse anything else', () => {
    for (const day of ['2026-10-21', '2024-02-29', '1900-01-01', '9999-12-31']) assert.equal(isAmazonSpendingDay(day), true, day);
    for (const day of ['2026-02-29', '2026-13-01', '2026-10-32', '1899-12-31', '0001-01-01', '26-10-21', '2026-1-1',
      '2026-10-21T00:00:00Z', '', null, 20261021]) {
      assert.equal(isAmazonSpendingDay(day), false, String(day));
    }
    assert.throws(() => amazonSpendingWindowRange('30D', '2026-02-29'), RangeError);
    assert.throws(() => amazonSpendingWindowRange('5Y' as never, '2026-10-21'), RangeError);
  });
});
