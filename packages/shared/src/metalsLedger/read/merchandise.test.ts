import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { metalsAllocation } from '../allocation.js';
import type { MetalsOrderComponent, MetalsSkeletonLine } from '../model.js';
import { metalsMerchandise } from './merchandise.js';

/** Synthetic skeletons only. */
const item = (ordinal: number, amountMinor: number, extra: Partial<MetalsSkeletonLine> = {}): MetalsSkeletonLine => ({
  ordinal, kind: 'item', amountMinor, shippingMinor: null, feeParent: null, couponTarget: null, taxFlag: null, metal: true, ...extra,
});
const other = (ordinal: number, amountMinor: number, extra: Partial<MetalsSkeletonLine> = {}) => item(ordinal, amountMinor, { metal: false, ...extra });
/** A coupon line: `target` is the line it discounts, or null for an order-level one (never metal itself). */
const coupon = (ordinal: number, amountMinor: number, target: number | null, extra: Partial<MetalsSkeletonLine> = {}): MetalsSkeletonLine =>
  ({ ...item(ordinal, amountMinor, { metal: target !== null, ...extra }), kind: 'coupon', couponTarget: target });
/** A fee line: `parent` is its line, or null for an order-level one (never metal itself). */
const fee = (ordinal: number, amountMinor: number, parent: number | null, extra: Partial<MetalsSkeletonLine> = {}): MetalsSkeletonLine =>
  ({ ...item(ordinal, amountMinor, { metal: parent !== null, ...extra }), kind: 'fee', feeParent: parent });

/** Deep-frozen, so any write to an input throws (ES modules run in strict mode): the helper changes nothing it reads. */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

const merchandise = (skeleton: MetalsSkeletonLine[], components: MetalsOrderComponent[], ordinal: number) =>
  metalsMerchandise(frozen(skeleton), frozen(components), ordinal);
/** The ledger's own allocation of the order: line `ordinal`'s shares of `component`, as metalsAllocation splits them. */
const ledgerShares = (skeleton: MetalsSkeletonLine[], components: MetalsOrderComponent[], ordinal: number, component: string) =>
  metalsAllocation(skeleton, components).lines.find((line) => line.ordinal === ordinal)!.allocated.filter((share) => share.component === component);

/**
 * What a call threw when it threw a RangeError: its message, or null when it returned. Any other error is re-thrown as
 * it is, so no other failure can pass for the assertion made on this result (kill standard §8).
 */
function rangeErrorOf(call: () => unknown): string | null {
  try {
    call();
    return null;
  } catch (error) {
    if (!(error instanceof RangeError) || error.constructor !== RangeError) throw error;
    return error.message;
  }
}

describe('merchandise: a line\'s amount and its coupons', () => {
  it('a warehouse receipt: the amount plus the coupon that targets it, never the tax or an order-level fee', () => {
    const skeleton = [item(0, 205000, { taxFlag: 'taxable' }), coupon(1, -5000, 0), fee(2, 100, null)];
    const components: MetalsOrderComponent[] = [{ kind: 'tax', amountMinor: 1500 }];
    const couponed = merchandise(skeleton, components, 0);
    // The ledger's cost of the same line carries the fee and the tax.
    const receiptCost = metalsAllocation(skeleton, components).lines[0].totalMinor;
    assert.deepEqual([couponed, receiptCost], [{ totalMinor: 200000, discounts: [], complete: true }, 201600]);
  });

  it('only the coupons that target the line, each by its amount alone: a coupon\'s own shipping is never merchandise', () => {
    const skeleton = [item(0, 100000, { shippingMinor: 700 }), coupon(1, -2000, 0, { shippingMinor: 150 }), item(2, 50000), coupon(3, -3000, 2)];
    const shippedBar = merchandise(skeleton, [], 0);
    const nextBar = merchandise(skeleton, [], 2);
    // The ledger's direct cost counts the line's own shipping and its coupon's.
    const shippedDirect = metalsAllocation(skeleton, []).lines[0].directMinor;
    assert.deepEqual([shippedBar, nextBar, shippedDirect],
      [{ totalMinor: 98000, discounts: [], complete: true }, { totalMinor: 47000, discounts: [], complete: true }, 98850]);
  });

  it('never a fee: neither one parented to the line nor an order-level one, nor either one\'s own shipping', () => {
    const skeleton = [item(0, 200000), fee(1, 300, 0, { shippingMinor: 40 }), fee(2, 250, null, { shippingMinor: 60 })];
    const feeless = merchandise(skeleton, [], 0);
    // The ledger's cost carries both fees, each with its own shipping.
    const feeCost = metalsAllocation(skeleton, []).lines[0].totalMinor;
    assert.deepEqual([feeless, feeCost], [{ totalMinor: 200000, discounts: [], complete: true }, 200650]);
  });
});

describe('merchandise: the order-level discounts, attributed as the ledger attributes them', () => {
  it('a coupon that targets no line, on an all-metal receipt: each line\'s share, the ledger\'s, by its amount', () => {
    const skeleton = [
      item(0, 205000, { taxFlag: 'taxable' }), item(1, 410000, { taxFlag: 'taxable' }), coupon(2, -10000, 1), coupon(3, -900, null), fee(4, 50, null),
    ];
    const components: MetalsOrderComponent[] = [{ kind: 'tax', amountMinor: 1200 }];
    // Bases 205000 and 400000: the odd cent of 900 goes to the larger remainder, line 0's.
    const oneBar = merchandise(skeleton, components, 0);
    const twoBars = merchandise(skeleton, components, 1);
    assert.deepEqual([oneBar, twoBars], [
      { totalMinor: 204695, discounts: [{ component: 'coupon@3', amountMinor: -305 }], complete: true },
      { totalMinor: 399405, discounts: [{ component: 'coupon@3', amountMinor: -595 }], complete: true },
    ]);
    assert.deepEqual([oneBar.discounts, twoBars.discounts], [ledgerShares(skeleton, components, 0, 'coupon@3'), ledgerShares(skeleton, components, 1, 'coupon@3')]);
  });

  it('an online order\'s discount: its share by the ledger\'s bases, never the line\'s shipping, fees or tax', () => {
    const skeleton = [item(0, 600000, { shippingMinor: 1500 }), fee(1, 300, 0), item(2, 200000, { shippingMinor: 0 }), fee(3, 200, null)];
    const components: MetalsOrderComponent[] = [{ kind: 'tax', amountMinor: 4800 }, { kind: 'discount', amountMinor: -1000 }];
    // Bases 601800 (its amount, shipping and fee) and 200000: the odd cent goes to line 0.
    const charged = merchandise(skeleton, components, 0);
    const plain = merchandise(skeleton, components, 2);
    assert.deepEqual([charged, plain, ledgerShares(skeleton, components, 0, 'discount')], [
      { totalMinor: 599249, discounts: [{ component: 'discount', amountMinor: -751 }], complete: true },
      { totalMinor: 199751, discounts: [{ component: 'discount', amountMinor: -249 }], complete: true },
      [{ component: 'discount', amountMinor: -751 }],
    ]);
    // The ledger's cost is the merchandise plus the line's shipping, its fee and its shares of the order fee and the tax.
    const ledger = metalsAllocation(skeleton, components).lines[0];
    const charges = ledger.allocated.filter((share) => share.component !== 'discount').reduce((total, share) => total + share.amountMinor, 0);
    assert.deepEqual([ledger.totalMinor - charged.totalMinor, charges], [1500 + 300 + charges, 3753]);
  });

  it('a coupon that targets no line keeps its amount alone: its own shipping is never merchandise', () => {
    const skeleton = [item(0, 100000), coupon(1, -1000, null, { shippingMinor: 250 })];
    const couponOnly = merchandise(skeleton, [], 0);
    // The ledger's share of the coupon carries the coupon's shipping.
    const couponCost = metalsAllocation(skeleton, []).lines[0].totalMinor;
    assert.deepEqual([couponOnly, couponCost], [{ totalMinor: 99000, discounts: [{ component: 'coupon@1', amountMinor: -1000 }], complete: true }, 99250]);
  });
});

describe('merchandise: complete exactly when no order-level discount that could reach the line stayed unattributed', () => {
  it('a coupon that targets no line, on a mixed receipt: unattributed, no share, and the line incomplete', () => {
    const skeleton = [item(0, 205000, { taxFlag: 'non-taxable' }), other(1, 3000, { taxFlag: 'taxable' }), coupon(2, -400, null)];
    const components: MetalsOrderComponent[] = [{ kind: 'tax', amountMinor: 240 }];
    const mixedBar = merchandise(skeleton, components, 0);
    const mixedOther = merchandise(skeleton, components, 1);
    assert.deepEqual([mixedBar, mixedOther], [{ totalMinor: 205000, discounts: [], complete: false }, { totalMinor: 3000, discounts: [], complete: false }]);
  });

  it('an online discount on a mixed order: unattributed, no share, and the line incomplete', () => {
    const skeleton = [item(0, 200000, { shippingMinor: 0 }), other(1, 5000, { shippingMinor: 0 })];
    const mixedOnline = merchandise(skeleton, [{ kind: 'discount', amountMinor: -500 }], 0);
    assert.deepEqual(mixedOnline, { totalMinor: 200000, discounts: [], complete: false });
  });

  it('an unattributed tax, shipping or fee leaves it complete, though the ledger\'s cost is incomplete', () => {
    const skeleton = [item(0, 200000), other(1, 5000), fee(2, 300, null), { ...other(3, 4000), kind: 'fuel' as const }];
    const components: MetalsOrderComponent[] = [{ kind: 'tax', amountMinor: 1000 }, { kind: 'shipping', amountMinor: 999 }];
    const untaxed = merchandise(skeleton, components, 0);
    const fuel = merchandise(skeleton, components, 3);
    const ledgerComplete = metalsAllocation(skeleton, components).lines.map((line) => line.complete);
    assert.deepEqual([untaxed, fuel, ledgerComplete],
      [{ totalMinor: 200000, discounts: [], complete: true }, { totalMinor: 4000, discounts: [], complete: true }, [false, false, false]]);
  });

  it('a discount no line can take (no positive base) leaves every line incomplete', () => {
    const skeleton = [item(0, 1000), coupon(1, -1000, 0), item(2, 0)];
    const components: MetalsOrderComponent[] = [{ kind: 'discount', amountMinor: -100 }];
    const zeroBase = merchandise(skeleton, components, 0);
    const zeroLine = merchandise(skeleton, components, 2);
    assert.deepEqual([zeroBase, zeroLine], [{ totalMinor: 0, discounts: [], complete: false }, { totalMinor: 0, discounts: [], complete: false }]);
  });

  it('a mixed discount reaches only the lines with a base: a line of amount 0 can take none, and stays complete', () => {
    const skeleton = [item(0, 200000), item(1, 0), other(2, 5000)];
    const components: MetalsOrderComponent[] = [{ kind: 'discount', amountMinor: -500 }];
    const reached = merchandise(skeleton, components, 0);
    const unreached = merchandise(skeleton, components, 1);
    assert.deepEqual([reached, unreached], [{ totalMinor: 200000, discounts: [], complete: false }, { totalMinor: 0, discounts: [], complete: true }]);
  });

  it('a zero discount, or the own shipping of a coupon that targets no line, never leaves it waiting', () => {
    const skeleton = [item(0, 200000), other(1, 5000), coupon(2, 0, null, { shippingMinor: 300 })];
    const zeroDiscount = merchandise(skeleton, [{ kind: 'discount', amountMinor: 0 }], 0);
    // The ledger's cost waits for the coupon's shipping, which it can't split between the two lines.
    const shippingWaits = metalsAllocation(skeleton, []).lines[0].complete;
    assert.deepEqual([zeroDiscount, shippingWaits], [{ totalMinor: 200000, discounts: [], complete: true }, false]);
  });
});

describe('merchandise: the line it names', () => {
  it('names an item or fuel line only, and refuses a skeleton with a structural fault, with RangeErrors', () => {
    const skeleton = [item(0, 200000), coupon(1, -500, 0), { ...other(2, 4000), kind: 'fuel' as const }];
    const fuelLine = merchandise(skeleton, [], 2);
    const refusals = [
      rangeErrorOf(() => merchandise(skeleton, [], 1)), rangeErrorOf(() => merchandise(skeleton, [], 3)), rangeErrorOf(() => merchandise([item(1, 200000)], [], 1)),
    ];
    assert.deepEqual([fuelLine, refusals], [{ totalMinor: 4000, discounts: [], complete: true }, [
      'metalsMerchandise: line 1 is no item or fuel line of the skeleton',
      'metalsMerchandise: line 3 is no item or fuel line of the skeleton',
      'metalsAllocation: the skeleton has ordinals out of order',
    ]]);
  });
});
