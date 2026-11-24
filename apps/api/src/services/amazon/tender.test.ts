import { describe, expect, it } from 'vitest';
import { syntheticCapture } from './fixtures.testSupport.js';
import { singleCardProven } from './tender.js';
import { validateCapture } from './capture.js';
import type { OrderObservation } from './types.js';

describe('independent complete native tender proof', () => {
  const order = () => syntheticCapture().staging.orders[0];
  it('requires positive complete source markers and exact typed reconciliation', async () => {
    const o = order();
    expect(singleCardProven(o)).toBe(true);
    o.summary!.push({ kind: 'promotion', money: { currency: 'USD', amountMinor: 100 } });
    o.summary!.find(s => s.kind === 'items-subtotal')!.money.amountMinor = 1100;
    expect(singleCardProven(o)).toBe(true);
    const capture = syntheticCapture(); capture.staging.orders[0] = o;
    await validateCapture(capture);
  });
  it.each(['methodComplete', 'summaryComplete', 'unknownMethod', 'unknownSummary', 'conflict'] as const)(
    'refuses a claimed proven order if marker %s contradicts source completeness', async key => {
      const capture = syntheticCapture(), o = capture.staging.orders[0];
      o.tenderProof![key] = !o.tenderProof![key];
      expect(singleCardProven(o)).toBe(false);
      await expect(validateCapture(capture)).rejects.toThrow();
      o.tenderCoverage = 'unknown';
      await validateCapture(capture); // Incomplete observations are legal, but never matching proof.
    });
  it.each(['items-subtotal', 'shipping', 'tax', 'grand-total'] as const)(
    'never defaults absent %s to zero', async kind => {
      const capture = syntheticCapture(), o = capture.staging.orders[0];
      o.summary = o.summary!.filter(s => s.kind !== kind);
      expect(singleCardProven(o)).toBe(false);
      await expect(validateCapture(capture)).rejects.toThrow();
    });
  const badMethods: Array<NonNullable<OrderObservation['paymentMethods']>> = [
    [], [{ kind: 'card', network: 'visa', last4: null }], [{ kind: 'card', network: 'unknown', last4: '9001' }],
    [{ kind: 'balance', network: 'unknown', last4: null }], [{ kind: 'points', network: 'unknown', last4: null }],
    [{ kind: 'unknown', network: 'unknown', last4: null }],
    [{ kind: 'card', network: 'visa', last4: '9001' }, { kind: 'card', network: 'visa', last4: '9002' }],
  ];
  it.each(badMethods.map((methods, n) => ({ methods, n })))('holds incomplete/mixed/unknown method case $n', async ({ methods }) => {
    const capture = syntheticCapture(), o = capture.staging.orders[0]; o.paymentMethods = methods;
    expect(singleCardProven(o)).toBe(false);
    await expect(validateCapture(capture)).rejects.toThrow();
  });
  it.each(['gift-card', 'rewards'] as const)('holds any observed %s tender line', async kind => {
    const capture = syntheticCapture(), o = capture.staging.orders[0];
    o.summary!.push({ kind, money: { currency: 'USD', amountMinor: 1 } });
    expect(singleCardProven(o)).toBe(false);
    await expect(validateCapture(capture)).rejects.toThrow();
  });
  it('holds arithmetic/currency conflicts, unsafe/negative amounts, duplicate labels, missing proof and unknown labels', async () => {
    const cases = [
      (o: OrderObservation) => { o.summary![0].money.amountMinor++; },
      (o: OrderObservation) => { o.summary![0].money.currency = 'EUR'; },
      (o: OrderObservation) => { o.summary![0].money.amountMinor = Number.MAX_SAFE_INTEGER + 1; },
      (o: OrderObservation) => { o.summary!.push({ kind: 'promotion', money: { currency: 'USD', amountMinor: -10 } }); },
      (o: OrderObservation) => { o.summary!.push(structuredClone(o.summary![0])); },
      (o: OrderObservation) => { delete o.tenderProof; },
      (o: OrderObservation) => { Object.assign(o.summary![0], { kind: 'unrecognized-label' }); },
    ];
    for (const mutate of cases) {
      const capture = syntheticCapture(); mutate(capture.staging.orders[0]);
      expect(singleCardProven(capture.staging.orders[0])).toBe(false);
      await expect(validateCapture(capture)).rejects.toThrow();
    }
  });
});
