import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateCapture } from './capture.js';
import { syntheticCapture } from './fixtures.testSupport.js';

// Synthetic only. The API's own capture checks don't lean on the producer's: a field that reads as an allowed value only
// once coerced refuses here, before the producer's validator is consulted. The producer is the real one, only counted.
const producer = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../../../../tools/amazon-capture/amazon-capture.mjs', async importOriginal => {
  const actual = await importOriginal<{ validateAmazonCapture: (value: unknown) => unknown }>();
  return { ...actual, validateAmazonCapture: (value: unknown) => { producer.calls++; return actual.validateAmazonCapture(value); } };
});
type Capture = ReturnType<typeof syntheticCapture>;
const fields: Array<[string, (c: Capture, value: unknown) => void, string]> = [
  ['staging mode', (c, value) => { Object.assign(c.staging, { mode: value }); }, 'recent'],
  ['tender coverage', (c, value) => { Object.assign(c.staging.orders[0], { tenderCoverage: value }); }, 'single-card-proven'],
  ['summary kind', (c, value) => { Object.assign(c.staging.orders[0].summary![1], { kind: value }); }, 'shipping'],
  ['payment method kind', (c, value) => {
    Object.assign(c.staging.orders[0], { tenderCoverage: 'unknown', paymentMethods: [{ kind: value, network: 'unknown', last4: null }] });
  }, 'balance'],
  ['payment method network', (c, value) => { Object.assign(c.staging.orders[0].paymentMethods![0], { network: value }); }, 'visa'],
  ['ledger provenance status', (c, value) => {
    Object.assign(c.staging, { payments: [{ date: '2026-09-03', money: { currency: 'USD', amountMinor: 1100 }, kind: 'unknown',
      status: 'pending', method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: [c.staging.orders[0].orderId],
      identity: 'native-row', provenance: { source: 'ledger', status: value, page: 0, ordinal: 0 } }] });
    c.staging.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 };
  }, 'Pending'],
];
beforeEach(() => { producer.calls = 0; });

describe('capture boundary, independent of the producer', () => {
  it.each(fields)('refuses an array-wrapped %s before consulting the producer', async (_field, set, value) => {
    const valid = syntheticCapture();
    set(valid, value);
    await expect(validateCapture(valid)).resolves.toBeDefined();
    expect(producer.calls).toBe(1);
    for (const wrapped of [[value], [[value]]]) {
      producer.calls = 0;
      const c = syntheticCapture();
      set(c, wrapped);
      await expect(validateCapture(c)).rejects.toThrow('amazon input refused');
      expect(producer.calls).toBe(0);
    }
  });
});
