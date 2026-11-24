import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { delivered, metalItem, syntheticKey, syntheticOrder, syntheticPayload, walmartAdmittedOrder } from './__fixtures__/metalsPayloads.js';
import { metalsAllocation } from './allocation.js';
import type { MetalsContentDecision } from './contentRule.js';
import { metalsEffectiveSkeleton, type MetalsEffectiveOrder, type MetalsOrderDecisions } from './effective.js';
import type { MetalsBullionAnswer, MetalsLineMetalUncertain, MetalsSource } from './model.js';
import { validateMetalsImportPayload, type MetalsOrder } from './payload.js';

/** Synthetic orders only: invented titles, refs, amounts and last 4s. */
const FLAG: MetalsLineMetalUncertain = { guard: 'metal-guard-v1', evidence: ['shape-with-weight'], metal: 'XAU' };

/** A Walmart order: a flagged line (item 0, with a fee and a coupon of its own), an unflagged gold bar (item 3), and shipping. */
function mixedOrder(): MetalsOrder {
  return syntheticOrder({
    source: 'walmart', channel: 'online', id: 'e1', date: '2030-01-10',
    skeleton: [metalItem(0, 100000), metalItem(1, 500, { kind: 'fee', feeParent: 0 }), metalItem(2, -2000, { kind: 'coupon', couponTarget: 0 }),
      metalItem(3, 50000)],
    components: [{ kind: 'shipping', amountMinor: 1000 }],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 149500 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 149500,
    },
    lines: [
      { ordinal: 0, title: 'Sample Refinery Gold Bar Assay Card 1 oz', productRef: 'walmart:200001', metal: null, metalUncertain: FLAG,
        form: null, statedMass: null, pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 100000,
        events: [delivered(1, '2030-01-14')] },
      { ordinal: 3, title: 'Sample Refinery 1 ozt Gold Bar FINE GOLD .9999', productRef: 'walmart:200002', metal: 'XAU', form: 'bar',
        statedMass: { value: '1', unit: 'ozt' }, pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null,
        quantity: 1, unitPriceMinor: 50000, events: [delivered(1, '2030-01-14')] },
    ],
  });
}

const standing = (decisions: MetalsContentDecision[], overrides: Partial<MetalsOrderDecisions> = {}): MetalsOrderDecisions =>
  ({ evidenceDigest: 'digest-one', decisions, productRefUnique: () => true, ...overrides });
const lotAnswer = (order: MetalsOrder, answer: MetalsBullionAnswer, evidenceDigest = 'digest-one'): MetalsContentDecision =>
  ({ kind: 'bullion', scope: 'lot', lotKey: order.lines[0].key, evidenceDigest, answer });
const productAnswer = (order: MetalsOrder, answer: MetalsBullionAnswer): MetalsContentDecision =>
  ({ kind: 'bullion', scope: 'product', productRef: order.lines[0].productRef!, fingerprint: order.lines[0].contentFingerprint, answer });
const metals = (effective: MetalsEffectiveOrder) => effective.skeleton.map((line) => line.metal);

/**
 * The one refusal the projection's tests may meet as data: metalsAllocation's refusal of a skeleton whose fee or coupon
 * carries another metal flag than its own line (allocation.ts), exactly as it is thrown. It is the declared outcome of
 * mutant E1 (a not-bullion line's fee and coupon left metal); any other refusal or error is never caught.
 */
const DECLARED_REFUSAL = 'metalsAllocation: the skeleton has a fee or coupon whose metal flag differs from its line';

/**
 * The projection, or the declared refusal as data: a RangeError with exactly DECLARED_REFUSAL's message, kept as it is.
 * Every other error is re-thrown unchanged (ROOT's kill standard, addendum 3(e) and ruling 10a), so an unexpected error
 * fails its test as itself, never as an assertion. Each test asserts in its own body that its projection was not refused:
 * it is always a sound skeleton.
 */
function projection(order: MetalsOrder, decisions: MetalsOrderDecisions, source: MetalsSource = 'walmart'):
  { effective: MetalsEffectiveOrder; refused: null } | { effective: null; refused: string } {
  try {
    return { effective: metalsEffectiveSkeleton(order, source, decisions), refused: null };
  } catch (error) {
    if (error instanceof RangeError && error.message === DECLARED_REFUSAL) return { effective: null, refused: error.message };
    throw error;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe('metals effective skeleton: "not bullion" rebuilds the whole order (design 4c.2, synthetic)', () => {
  it('reads a valid stored order', () => {
    const result = validateMetalsImportPayload(syntheticPayload('walmart', { orders: [mixedOrder()] }));
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  });

  it('a not-bullion line leaves metal with its own fee and coupon, and the whole order is allocated again', () => {
    const order = mixedOrder();
    assert.deepEqual([order.lines[1].costMinor, order.lines[1].complete], [50337, true]);
    const projected = projection(order, standing([lotAnswer(order, 'not-bullion')]));
    assert.equal(projected.refused, null);
    const effective = projected.effective!;
    assert.deepEqual(effective.answers, [{ key: order.lines[0].key, ordinal: 0, answer: 'not-bullion', drift: false }]);
    assert.deepEqual(metals(effective), [false, false, false, true]);
    // A newly mixed skeleton: the shipping no longer goes to the surviving bar, which is now incomplete.
    const survivor = effective.allocation.lines.find((line) => line.ordinal === 3)!;
    assert.deepEqual([survivor.metal, survivor.totalMinor, survivor.complete, survivor.allocated], [true, 50000, false, []]);
    assert.equal(effective.allocation.unattributedMinor, 1000);
    assert.equal(effective.allocation.fullPriceMinor, order.fullPriceMinor);
    const byProduct = projection(order, standing([productAnswer(order, 'not-bullion')]));
    assert.equal(byProduct.refused, null);
    assert.deepEqual(metals(byProduct.effective!), [false, false, false, true]);
  });

  it('a line decided bullion, undecided, drifted or only content-confirmed stays metal, as stored', () => {
    const order = mixedOrder();
    const stored = metalsAllocation(order.skeleton, order.components);
    const contentOnly: MetalsContentDecision = { scope: 'lot', lotKey: order.lines[0].key, evidenceDigest: 'digest-one', troyOzPerUnit: '1/1' };
    const cases: Array<[MetalsOrderDecisions, MetalsBullionAnswer | null, boolean]> = [
      [standing([lotAnswer(order, 'bullion')]), 'bullion', false],
      [standing([]), null, false],
      [standing([lotAnswer(order, 'not-bullion', 'digest-two')]), null, true],
      [standing([productAnswer(order, 'not-bullion')], { productRefUnique: () => false }), null, true],
      [standing([contentOnly]), null, false],
    ];
    for (const [decisions, answer, drift] of cases) {
      const projected = projection(order, decisions);
      assert.equal(projected.refused, null);
      const effective = projected.effective!;
      assert.deepEqual(effective.answers.map((entry) => [entry.answer, entry.drift]), [[answer, drift]], JSON.stringify(decisions.decisions));
      assert.deepEqual(effective.skeleton, order.skeleton);
      assert.deepEqual(effective.allocation, stored);
    }
  });

  it('changes nothing it reads: keys, raw skeleton, funding, money, flags and fingerprints', () => {
    const order = deepFreeze(mixedOrder());
    const before = JSON.stringify(order);
    const projected = projection(order, deepFreeze(standing([lotAnswer(order, 'not-bullion')])));
    assert.equal(projected.refused, null);
    const effective = projected.effective!;
    assert.equal(JSON.stringify(order), before);
    assert.notEqual(effective.skeleton, order.skeleton);
    const shape = (line: MetalsOrder['skeleton'][number]) =>
      [line.ordinal, line.kind, line.amountMinor, line.shippingMinor, line.feeParent, line.couponTarget, line.taxFlag];
    assert.deepEqual(effective.skeleton.map(shape), order.skeleton.map(shape));
    assert.equal(effective.allocation.fullPriceMinor, order.admission!.grossTotalMinor);
  });

  it('never touches a line with no flag, whatever decisions are read for it', () => {
    const order = walmartAdmittedOrder(1);
    const decision: MetalsContentDecision = { kind: 'bullion', scope: 'lot', lotKey: order.lines[0].key, evidenceDigest: 'digest-one', answer: 'not-bullion' };
    const projected = projection(order, standing([decision]));
    assert.equal(projected.refused, null);
    const effective = projected.effective!;
    assert.deepEqual(effective.answers, []);
    assert.deepEqual(effective.skeleton, order.skeleton);
  });

  it('allocates a sale\'s proceeds again too', () => {
    const sale = syntheticOrder({
      source: 'collectpure', channel: 'online', id: 'es', date: '2030-03-02', completedDate: '2030-03-12',
      skeleton: [metalItem(0, 100000), metalItem(1, 50000)], components: [{ kind: 'platform-fee', amountMinor: -1500 }],
      lines: [
        { ordinal: 0, title: 'Sample Gold Bar Assay Card 1 oz', productRef: 'collectpure:SKU-E1', metal: null, metalUncertain: FLAG, form: null,
          statedMass: null, pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 100000, events: [] },
        { ordinal: 1, title: '1 oz Gold American Eagle', productRef: 'collectpure:SKU-E2', metal: 'XAU', form: 'coin',
          statedMass: { value: '1', unit: 'oz' }, pack: 'single', purity: null, massBasis: 'none', design: 'eagle', quantity: 1,
          unitPriceMinor: 50000, events: [] },
      ],
      payouts: [{ key: syntheticKey('collectpure', 'payout', 'es'), method: 'ach', destinationLast4: '5555', amountMinor: 148500,
        initiatedDate: '2030-03-11', payoutDate: '2030-03-12', status: 'complete' }],
    });
    assert.deepEqual([sale.lines[1].netMinor, sale.lines[1].complete], [49500, true]);
    const projected = projection(sale, standing([lotAnswer(sale, 'not-bullion')]), 'collectpure');
    assert.equal(projected.refused, null);
    const effective = projected.effective!;
    assert.deepEqual(metals(effective), [false, true]);
    assert.deepEqual([effective.allocation.lines[1].totalMinor, effective.allocation.lines[1].complete], [50000, false]);
    assert.equal(effective.allocation.unattributedMinor, -1500);
  });
});
