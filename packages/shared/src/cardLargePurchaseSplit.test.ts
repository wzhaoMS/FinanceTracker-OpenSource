import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeCardInsights, splitLargeCardPurchases } from './cardInsights.js';
import { cardSpendingExclusionOf, cardSpendingRole } from './cardSpending.js';
import { addMonths, daysIn, syntheticSpendingLedger } from './__fixtures__/syntheticSpendingLedger.js';

// Synthetic ledgers only (__fixtures__/syntheticSpendingLedger.ts).

const within = (date: string, range: { from: string; to: string }) => date >= range.from && date <= range.to;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe('the large one-off split', () => {
  it('splits posted spending exactly, in any range of days: large − refunds set against them + everyday', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const ledger = syntheticSpendingLedger({ seed, months: 20, foreign: seed % 3 === 0 });
      const through = `${ledger.lastMonth}-${daysIn(ledger.lastMonth)}`;
      const split = splitLargeCardPurchases(ledger.rows, { currency: 'USD', through });
      assert.ok(split.large.length > 0, `seed ${seed} has large purchases`);
      const spent = ledger.rows.filter((row) => row.currency === 'USD' && row.status === 'posted'
        && cardSpendingRole(row.kind) === 'spending' && !cardSpendingExclusionOf(row));
      const byId = new Map(ledger.rows.map((row) => [row.id, row]));
      for (let offset = 0; offset < 20; offset += 1) {
        for (const length of [1, 2, 3, 12]) {
          const from = `${addMonths(ledger.firstMonth, offset)}-01`;
          const lastMonth = addMonths(ledger.firstMonth, offset + length - 1);
          const range = { from, to: `${lastMonth}-${daysIn(lastMonth)}` };
          const spending = sum(spent.filter((row) => within(row.transactionDate, range)).map((row) => row.amountMinor));
          const large = sum(split.large.filter((item) => within(item.row.transactionDate, range)).map((item) => item.row.amountMinor));
          const setAgainst = sum([...split.refundsSetAgainstLarge].filter(([id]) => within(byId.get(id)!.transactionDate, range)).map(([, minor]) => minor));
          const everyday = sum(split.everyday.filter((row) => within(row.transactionDate, range)).map((row) => row.amountMinor));
          assert.equal(large - setAgainst + everyday, spending, `seed ${seed} ${range.from}..${range.to}`);
        }
      }
      for (const item of split.large) {
        assert.equal(item.netMinor, item.row.amountMinor - item.refundedMinor);
        assert.ok(item.refundedMinor >= 0 && item.netMinor >= 0 && item.row.amountMinor >= split.thresholdMinor);
        // The owner's precious metals are no one-off spending: they are not spending at all.
        assert.notEqual(item.row.userCategory, 'Precious metals');
      }
      assert.equal(sum([...split.refundsSetAgainstLarge.values()]), sum(split.large.map((item) => item.refundedMinor)));
    }
  });

  it('is the split the insights report: the same one-offs, totals and everyday spending for a period', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const ledger = syntheticSpendingLedger({ seed, months: 20 });
      for (const month of [addMonths(ledger.lastMonth, -1), addMonths(ledger.lastMonth, -7)]) {
        const period = { from: `${month}-01`, to: `${month}-${daysIn(month)}`, baseline: { from: `${addMonths(month, -1)}-01`, to: `${addMonths(month, -1)}-${daysIn(addMonths(month, -1))}` } };
        const today = `${ledger.lastMonth}-${daysIn(ledger.lastMonth)}`;
        const insights = computeCardInsights(ledger.rows, { month, today, currency: 'USD', period });
        const split = splitLargeCardPurchases(ledger.rows, { currency: 'USD', through: period.to, today });
        const inPeriod = split.large.filter((item) => within(item.row.transactionDate, period) && item.netMinor > 0)
          .sort((a, b) => b.netMinor - a.netMinor || (a.row.id < b.row.id ? -1 : 1));
        const core = sum(split.everyday.filter((row) => within(row.transactionDate, period)).map((row) => row.amountMinor));
        if (inPeriod.length === 0) {
          assert.equal(insights.largePurchases, null, `seed ${seed} ${month}`);
          continue;
        }
        assert.ok(insights.largePurchases);
        assert.equal(insights.largePurchases.thresholdMinor, split.thresholdMinor);
        assert.equal(insights.largePurchases.count, inPeriod.length);
        assert.equal(insights.largePurchases.totalMinor, sum(inPeriod.map((item) => item.netMinor)));
        assert.equal(insights.largePurchases.coreMinor, core);
        assert.deepEqual(insights.largePurchases.items.map((item) => [item.id, item.amountMinor, item.refundedMinor, item.key]),
          inPeriod.slice(0, 5).map((item) => [item.row.id, item.netMinor, item.refundedMinor, item.key]));
      }
    }
  });
});
