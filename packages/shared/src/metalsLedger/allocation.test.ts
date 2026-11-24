import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { metalsAllocation, metalsSkeletonProblem, metalsUnitSplit } from './allocation.js';
import type { MetalsOrderComponent, MetalsSkeletonLine } from './model.js';

/** Synthetic skeletons only. */
const line = (ordinal: number, amountMinor: number, extra: Partial<MetalsSkeletonLine> = {}): MetalsSkeletonLine => ({
  ordinal, kind: 'item', amountMinor, shippingMinor: null, feeParent: null, couponTarget: null, taxFlag: null, metal: true, ...extra,
});
const other = (ordinal: number, amountMinor: number, extra: Partial<MetalsSkeletonLine> = {}) => line(ordinal, amountMinor, { metal: false, ...extra });
const tax = (amountMinor: number): MetalsOrderComponent => ({ kind: 'tax', amountMinor });
const conserved = (skeleton: MetalsSkeletonLine[], components: MetalsOrderComponent[]) => {
  const allocation = metalsAllocation(skeleton, components);
  const placed = allocation.lines.reduce((total, entry) => total + entry.totalMinor, 0);
  assert.equal(placed + allocation.unattributedMinor, allocation.fullPriceMinor);
  return allocation;
};

describe('allocation: tax eligibility first (GV4-06)', () => {
  it('a non-taxable line gets exactly zero tax, even on an all-metal receipt with an odd cent', () => {
    const allocation = conserved([line(0, 100000, { taxFlag: 'non-taxable' }), line(1, 100000, { taxFlag: 'taxable' })], [tax(1)]);
    assert.deepEqual(allocation.lines.map((entry) => entry.totalMinor), [100000, 100001]);
    assert.deepEqual(allocation.lines[0].allocated, []);
    assert.deepEqual(allocation.components, [{ component: 'tax', amountMinor: 1, eligibility: 'stated', attributed: true, reason: null }]);
  });

  it('one unknown flag among known ones leaves the tax unattributed; a non-taxable line stays complete', () => {
    const allocation = conserved([
      line(0, 50000, { taxFlag: 'non-taxable' }), line(1, 50000, { taxFlag: null }), line(2, 50000, { taxFlag: 'taxable' }),
    ], [tax(300)]);
    assert.equal(allocation.unattributedMinor, 300);
    assert.equal(allocation.components[0].reason, 'tax-flags-partial');
    assert.deepEqual(allocation.lines.map((entry) => entry.complete), [true, false, false]);
    assert.deepEqual(allocation.lines.map((entry) => entry.totalMinor), [50000, 50000, 50000]);
  });

  it('with no flag stated, every principal line is eligible, labelled so', () => {
    const allocation = conserved([line(0, 30000), line(1, 10000)], [tax(400)]);
    assert.deepEqual(allocation.lines.map((entry) => entry.totalMinor), [30300, 10100]);
    assert.equal(allocation.components[0].eligibility, 'unstated-tax-eligibility');
  });

  it('tax with no taxable line at all stays unattributed and leaves every line incomplete', () => {
    const allocation = conserved([line(0, 10000, { taxFlag: 'non-taxable' }), other(1, 10000, { taxFlag: 'non-taxable' })], [tax(50)]);
    assert.equal(allocation.components[0].reason, 'no-positive-base');
    assert.deepEqual(allocation.lines.map((entry) => entry.complete), [false, false]);
  });
});

describe('allocation: attribution', () => {
  it('splits an odd cent among genuinely eligible metal bases by the ordinal rule', () => {
    const allocation = conserved([line(0, 100), line(1, 100), line(2, 100)], [{ kind: 'shipping', amountMinor: 2 }]);
    assert.deepEqual(allocation.lines.map((entry) => entry.totalMinor), [101, 101, 100]);
  });

  it('a mixed order\'s unassigned fee or shipping stays unattributed and marks the metal line incomplete', () => {
    const skeleton = [line(0, 100000), other(1, 5000), { ...line(2, 300, { metal: false }), kind: 'fee' as const }];
    const allocation = conserved(skeleton, [{ kind: 'shipping', amountMinor: 999 }]);
    assert.equal(allocation.unattributedMinor, 1299);
    assert.deepEqual(allocation.components.map((entry) => [entry.component, entry.reason]), [['fee@2', 'mixed-metal'], ['shipping', 'mixed-metal']]);
    assert.deepEqual(allocation.lines.map((entry) => entry.complete), [false, false]);
    assert.equal(allocation.lines[0].totalMinor, 100000);
  });

  it('a mixed order whose eligible lines are all non-metal attributes the component to them only', () => {
    const allocation = conserved([line(0, 100000, { taxFlag: 'non-taxable' }), other(1, 5000, { taxFlag: 'taxable' })], [tax(400)]);
    assert.deepEqual(allocation.lines.map((entry) => [entry.totalMinor, entry.complete]), [[100000, true], [5400, true]]);
  });

  it('targeted coupons and parented fees apply once, to their own line, with their own shipping', () => {
    const skeleton: MetalsSkeletonLine[] = [
      line(0, 100000, { shippingMinor: 500 }),
      line(1, 20000),
      { ...line(2, 150), kind: 'fee', feeParent: 0, shippingMinor: 50 },
      { ...line(3, -2000), kind: 'coupon', couponTarget: 1 },
    ];
    const allocation = conserved(skeleton, []);
    assert.deepEqual(allocation.lines.map((entry) => entry.directMinor), [100700, 18000]);
    assert.equal(allocation.fullPriceMinor, 118700);
  });

  it('splits a negative component by magnitude, keeping its sign', () => {
    const allocation = conserved([line(0, 100), line(1, 200)], [{ kind: 'discount', amountMinor: -31 }]);
    assert.deepEqual(allocation.lines.map((entry) => entry.allocated), [
      [{ component: 'discount', amountMinor: -10 }], [{ component: 'discount', amountMinor: -21 }],
    ]);
  });

  it('a non-zero component with no positive eligible base stays unattributed; a zero component is attributed trivially', () => {
    const coupons = [line(0, 1000), { ...line(1, -1000), kind: 'coupon' as const, couponTarget: 0 }];
    const allocation = conserved(coupons, [{ kind: 'shipping', amountMinor: 700 }, tax(0)]);
    assert.deepEqual(allocation.components.map((entry) => [entry.component, entry.attributed, entry.reason]),
      [['shipping', false, 'no-positive-base'], ['tax', true, null]]);
    assert.equal(allocation.lines[0].complete, false);
  });

  it('a sale\'s platform fee and insured shipping reduce its lines\' nets', () => {
    const allocation = conserved([line(0, 300000), line(1, 100000)], [
      { kind: 'platform-fee', amountMinor: -4001 }, { kind: 'insured-shipping', amountMinor: -2000 },
    ]);
    assert.deepEqual(allocation.lines.map((entry) => entry.totalMinor), [300000 - 3001 - 1500, 100000 - 1000 - 500]);
    assert.equal(allocation.fullPriceMinor, 393999);
  });

  it('conserves the full price on generated orders, and no attributed cent crosses the metal line (seeded)', () => {
    // mulberry32, so every run draws the same orders. (A float LCG lost its low bits past 2^53 and drew even numbers.)
    let state = 20301;
    const next = (bound: number) => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), state | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * bound);
    };
    let mixedRounds = 0;
    let otherOnlyRounds = 0;
    for (let round = 0; round < 500; round += 1) {
      const items = 1 + next(5);
      const skeleton: MetalsSkeletonLine[] = [];
      for (let index = 0; index < items; index += 1) {
        const flag = [null, 'taxable', 'non-taxable'][next(3)] as MetalsSkeletonLine['taxFlag'];
        skeleton.push(line(index, next(200000) - 1000, { metal: next(2) === 0, taxFlag: flag, shippingMinor: next(3) === 0 ? next(900) : null }));
      }
      if (next(2) === 0) skeleton.push({ ...line(skeleton.length, next(500), { metal: false }), kind: 'fee' });
      if (next(2) === 0) {
        const target = next(items);
        skeleton.push({ ...line(skeleton.length, -next(3000), { metal: skeleton[target].metal }), kind: 'coupon', couponTarget: target });
      }
      const allocation = conserved(skeleton, [tax(next(5000)), { kind: 'shipping', amountMinor: next(1500) }, { kind: 'discount', amountMinor: -next(800) }]);
      const shares = allocation.lines.flatMap((entry) => entry.allocated.map((share) => ({ ...share, metal: entry.metal })));
      for (const component of allocation.components) {
        const mine = shares.filter((share) => share.component === component.component);
        assert.equal(mine.reduce((total, share) => total + share.amountMinor, 0), component.attributed ? component.amountMinor : 0, component.component);
        assert.ok(mine.every((share) => share.metal === mine[0].metal), `${component.component} reached metal and non-metal lines`);
      }
      const itemLines = skeleton.filter((entry) => entry.kind === 'item');
      if (itemLines.some((entry) => entry.metal) && itemLines.some((entry) => !entry.metal)) mixedRounds += 1;
      if (itemLines.every((entry) => !entry.metal)) otherOnlyRounds += 1;
    }
    // The draws must reach both paths (about 300 and 100 of 500 expected), so a degenerate generator fails here.
    assert.ok(mixedRounds >= 100, `mixed-metal orders drawn: ${mixedRounds}`);
    assert.ok(otherOnlyRounds >= 25, `non-metal orders drawn: ${otherOnlyRounds}`);
  });
});

describe('allocation: units and structure', () => {
  it('splits a line\'s total over its units, earlier units first', () => {
    assert.deepEqual(metalsUnitSplit(10, 3), [4, 3, 3]);
    assert.deepEqual(metalsUnitSplit(-10, 3), [-4, -3, -3]);
    assert.deepEqual(metalsUnitSplit(0, 2), [0, 0]);
    assert.throws(() => metalsUnitSplit(10, 0));
  });

  it('refuses a skeleton whose fees, coupons or flags don\'t fit together', () => {
    const fee = (parent: number | null, metal = true) => ({ ...line(1, 100, { metal }), kind: 'fee' as const, feeParent: parent });
    const cases: Array<[MetalsSkeletonLine[], string]> = [
      [[], 'has no lines'],
      [[line(1, 100)], 'has ordinals out of order'],
      [[line(0, 100), fee(1)], 'has a fee whose parent is not an item'],
      [[line(0, 100), fee(0, false)], 'has a fee or coupon whose metal flag differs from its line'],
      [[line(0, 100), fee(null)], 'has an order-level fee or coupon marked metal'],
      [[line(0, 100), { ...line(1, -5), kind: 'coupon', couponTarget: 1 }], 'has a coupon whose target is not an item'],
      [[line(0, 100), { ...line(1, 5), feeParent: 0 }], 'has a parent on a line that is not a fee'],
      [[{ ...line(0, 100), kind: 'fuel' }], 'has a fuel line marked metal'],
      [[{ ...line(0, 100, { metal: false }), kind: 'fee' }], 'has no item'],
    ];
    for (const [skeleton, problem] of cases) {
      assert.equal(metalsSkeletonProblem(skeleton), problem, JSON.stringify(skeleton));
      assert.throws(() => metalsAllocation(skeleton, []));
    }
  });
});
