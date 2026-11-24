/**
 * Shape capture (plan §5.1) reports only what a contract's trusted metadata
 * (the descriptor's `shapeContracts`) allows: its fixed method and path
 * template, and its confirmed structural names. A dynamic object key or a
 * header name may be an account id or routing material, so every other name
 * is `<dynamic-key>`, whatever it looks like. The ISOLATED relay and the
 * worker refuse a report that is anything else.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAKE_AMEX, FAKE_CHASE, FAKE_CITI } from '../../src/adapters/fake/descriptors.js';
import { FAKE_AMEX_SHAPE } from '../../src/adapters/fake/amex/main.js';
import { FAKE_CHASE_SHAPE } from '../../src/adapters/fake/chase/shape.js';
import { FAKE_CITI_SHAPE } from '../../src/adapters/fake/citi/main.js';
import {
  SHAPE_DYNAMIC_KEY,
  SHAPE_REPORT_TYPE,
  shapeEntries,
  shapeHeaderName,
  shapeKeyName,
  shapeReportConfirmed,
  type ShapeReport,
} from '../../src/contracts/shapeReport.js';

const spec = FAKE_AMEX.shapeContracts['amex.recent.observe']!;
const confirmed = new Set<string>(spec.names);

test('shape capture names only confirmed structural names: any other key or header is <dynamic-key>, whatever it looks like', () => {
  assert.equal(shapeKeyName('transactions', confirmed), 'transactions');
  for (const key of ['SyntheticRoutingKeyAlpha', 'acctSelector', 'x', 'ABCDEFGH', '4111111111111111', 'transactions ']) {
    assert.equal(shapeKeyName(key, confirmed), SHAPE_DYNAMIC_KEY, key);
  }
  assert.equal(shapeHeaderName('Content-Type', confirmed), 'content-type');
  assert.equal(shapeHeaderName('syntheticroutingkeyalpha', confirmed), SHAPE_DYNAMIC_KEY);
  const { entries } = shapeEntries(
    { transactions: [{ amount: 1, description: 'x' }], hasMore: true, cardsByToken: { SyntheticRoutingKeyAlpha: { status: 'ACTIVE' } } },
    100,
    confirmed,
  );
  assert.deepEqual(entries.map((entry) => `${entry.path}: ${entry.type}`), [
    '$: object',
    '$.transactions: array',
    '$.transactions[]: object',
    '$.transactions[].amount: number',
    '$.transactions[].description: string',
    '$.hasMore: boolean',
    '$.<dynamic-key>: object',
    '$.<dynamic-key>.<dynamic-key>: object',
    '$.<dynamic-key>.<dynamic-key>.status: string',
  ]);
});

test('a shape report that is not exactly what its contract allows is refused (ISOLATED relay and worker)', () => {
  const report = (change: Partial<ShapeReport> = {}): ShapeReport => ({
    type: SHAPE_REPORT_TYPE,
    adapterId: 'fake-amex',
    issuer: 'amex',
    contract: 'amex.recent.observe',
    method: 'POST',
    pathTemplate: '/ReadAccountActivity.web.v1',
    queryKeys: [],
    requestMetaNames: ['content-type', SHAPE_DYNAMIC_KEY],
    requestShape: [{ path: '$.accountToken', type: 'string' }],
    responseShape: [{ path: '$.<dynamic-key>.<dynamic-key>.status', type: 'string' }, { path: '$[]', type: 'object' }],
    truncated: false,
    ...change,
  });
  assert.equal(shapeReportConfirmed(report(), spec), true);
  assert.equal(shapeReportConfirmed(report({ responseShape: [{ path: '$.cardsByToken.SyntheticRoutingKeyAlpha', type: 'object' }] }), spec), false);
  assert.equal(shapeReportConfirmed(report({ queryKeys: ['SyntheticRoutingKeyAlpha'] }), spec), false);
  assert.equal(shapeReportConfirmed(report({ requestMetaNames: ['syntheticroutingkeyalpha'] }), spec), false);
  // A path template or method other than the contract's fixed ones (a forged report with a routing segment, say).
  assert.equal(shapeReportConfirmed(report({ pathTemplate: '/ReadAccountActivity.web.v1/SyntheticRoutingKeyAlpha' }), spec), false);
  assert.equal(shapeReportConfirmed(report({ method: 'GET' }), spec), false);
  // A contract without trusted metadata reports nothing.
  assert.equal(shapeReportConfirmed(report(), undefined), false);
});

test('the MAIN shape observers report the method and path template their descriptor confirms', () => {
  for (const [adapter, descriptor] of [[FAKE_CHASE_SHAPE, FAKE_CHASE], [FAKE_AMEX_SHAPE, FAKE_AMEX], [FAKE_CITI_SHAPE, FAKE_CITI]] as const) {
    assert.equal(adapter.shapeContracts, descriptor.shapeContracts, descriptor.id);
    for (const contract of adapter.contracts) {
      const trusted = descriptor.shapeContracts[contract.contract];
      assert.ok(trusted, contract.contract);
      assert.equal(contract.method, trusted.method, contract.contract);
      assert.equal(contract.template, trusted.template, contract.contract);
      for (const key of contract.queryKeys) assert.ok(trusted.names.includes(key), `${contract.contract} ${key}`);
    }
  }
});
