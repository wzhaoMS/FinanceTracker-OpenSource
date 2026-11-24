import { test } from 'node:test';
import assert from 'node:assert/strict';

import { largestRemainderUnits, lineAmount, taxShare, type IntegerShareWeight } from './integerShares.js';

// Synthetic weights, amounts and keys only.
const weight = (ref: string, units: bigint, tie = ref): IntegerShareWeight => ({ ref, weight: units, tie });

/**
 * What an action was refused with: the shares' own refusal, by its exact message, or null when it was not refused.
 * Any other error is re-thrown unchanged, never turned into a result.
 */
function refusal(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    if (error instanceof RangeError && error.message === 'integer shares refused') return error.message;
    throw error;
  }
}

test('largest remainder gives each weight its floor share, then the units left to the largest remainders', () => {
  // 100 by 1:2:3 is 16.67, 33.33 and 50: floors 16, 33 and 50, and the one unit left goes to 16.67's remainder.
  assert.deepEqual([...largestRemainderUnits(100n, [weight('a', 1n), weight('b', 2n), weight('c', 3n)])],
    [['a', 17n], ['b', 33n], ['c', 50n]]);
  // 7 by 1:1:1:1 is 1.75 each: three units left, to the three lowest ties.
  assert.deepEqual([...largestRemainderUnits(7n, [weight('d', 1n), weight('c', 1n), weight('b', 1n), weight('a', 1n)])],
    [['a', 2n], ['b', 2n], ['c', 2n], ['d', 1n]]);
});

test('largest remainder gives a tied remainder to the lower tie, whatever order the weights come in', () => {
  const forward = [weight('row-1', 1n, 'tie-b'), weight('row-2', 1n, 'tie-a')];
  assert.deepEqual([...largestRemainderUnits(1n, forward)], [['row-2', 1n], ['row-1', 0n]]);
  assert.deepEqual([...largestRemainderUnits(1n, [...forward].reverse())], [['row-2', 1n], ['row-1', 0n]]);
});

test('largest remainder lists the weights from the largest remainder down', () => {
  // 10 by 3:5:2 is 3, 5 and 2 exactly: no remainder, so the ties order them.
  assert.deepEqual([...largestRemainderUnits(10n, [weight('c', 3n), weight('a', 5n), weight('b', 2n)]).keys()], ['a', 'b', 'c']);
  // 5 by 1:3 is 1.25 and 3.75: the larger remainder first.
  assert.deepEqual([...largestRemainderUnits(5n, [weight('a', 1n), weight('b', 3n)])], [['b', 4n], ['a', 1n]]);
});

test('largest remainder adds up to the total exactly, every share within one unit of its exact part', () => {
  for (let total = 0n; total <= 60n; total += 1n) {
    for (const units of [[1n], [1n, 1n], [1n, 2n, 3n], [5n, 5n, 1n, 9n], [2n ** 60n, 1n, 3n]]) {
      const weights = units.map((n, index) => weight(`w-${index}`, n));
      const shares = largestRemainderUnits(total, weights);
      const sum = units.reduce((n, w) => n + w, 0n);
      assert.equal([...shares.values()].reduce((n, share) => n + share, 0n), total, `${total} by ${units}`);
      for (const [index, n] of units.entries()) {
        const share = shares.get(`w-${index}`)!;
        assert.ok(share * sum >= total * n - sum && share * sum <= total * n + sum, `${total} by ${units}`);
      }
    }
  }
});

test('largest remainder refuses a negative total, no weights, a weight that is not positive, and a ref or a tie given twice', () => {
  assert.equal(refusal(() => largestRemainderUnits(-1n, [weight('a', 1n)])), 'integer shares refused');
  assert.equal(refusal(() => largestRemainderUnits(1n, [])), 'integer shares refused');
  assert.equal(refusal(() => largestRemainderUnits(1n, [weight('a', 0n), weight('b', 1n)])), 'integer shares refused');
  assert.equal(refusal(() => largestRemainderUnits(1n, [weight('a', -1n), weight('b', 2n)])), 'integer shares refused');
  assert.equal(refusal(() => largestRemainderUnits(1n, [weight('a', 1n, 'tie-a'), weight('a', 1n, 'tie-b')])), 'integer shares refused');
  assert.equal(refusal(() => largestRemainderUnits(1n, [weight('a', 1n, 'tie'), weight('b', 1n, 'tie')])), 'integer shares refused');
  // The bounds themselves are shared: a zero total, and one weight of one unit.
  assert.equal(refusal(() => largestRemainderUnits(0n, [weight('a', 1n)])), null);
});

test('a base\'s share of a tax is base × tax / subtotal, rounded half up', () => {
  assert.equal(taxShare(1000, 250, 4000), 63);
  assert.equal(taxShare(3000, 250, 4000), 188);
  assert.equal(taxShare(1500, 400, 5000), 120);
  assert.equal(taxShare(250, 1, 100), 3);
  assert.equal(taxShare(1, 1, 3), 0);
  assert.equal(taxShare(2, 1, 3), 1);
});

test('a base\'s share of a tax is zero unless the tax and the subtotal are positive safe integers', () => {
  assert.equal(taxShare(1000, 0, 4000), 0);
  assert.equal(taxShare(1000, -250, 4000), 0);
  assert.equal(taxShare(1000, 2.5, 4000), 0);
  assert.equal(taxShare(1000, 250, -4000), 0);
  assert.equal(taxShare(1000, 250, 2 ** 53), 0);
  assert.equal(taxShare(1000, 250, 0), 0);
  assert.equal(taxShare(1000, 250, null), 0);
});

test('a line\'s tax-inclusive amount takes the tax share on the line\'s units together', () => {
  const order = { taxMinor: 250, itemsSubtotalMinor: 4000 };
  assert.equal(lineAmount(order, { unitMinor: 500 }, 2), 1063);
  assert.equal(lineAmount(order, { unitMinor: 500 }, 1), 531);
  assert.equal(lineAmount({ taxMinor: 0, itemsSubtotalMinor: 4000 }, { unitMinor: 500 }, 3), 1500);
  assert.equal(lineAmount({ taxMinor: 250, itemsSubtotalMinor: null }, { unitMinor: 500 }, 3), 1500);
});
