import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { METALS_COMPLETENESS_CODES, MetalsReasons, metalsMeasure } from './completeness.js';

describe('completeness: every measure says how complete it is', () => {
  it('a value with no reason is complete; any reason makes it partial; no value is unknown, never zero', () => {
    assert.deepEqual(metalsMeasure(0), { value: 0, state: 'complete', reasons: [] });
    const reasons = new MetalsReasons().add('price-stale', 'lot-a');
    assert.deepEqual(metalsMeasure(1200, reasons), { value: 1200, state: 'partial', reasons: [{ code: 'price-stale', records: 1 }] });
    assert.deepEqual(metalsMeasure(null), { value: null, state: 'unknown', reasons: [] });
    assert.deepEqual(metalsMeasure(null, reasons).state, 'unknown');
  });

  it('counts each record once per code and lists codes in the closed list\'s order', () => {
    const reasons = new MetalsReasons()
      .add('not-covered', 'acct-a')
      .add('content-unknown', 'lot-a')
      .add('content-unknown', 'lot-a')
      .add('content-unknown', 'lot-b')
      .add('date-unknown', 'lot-a');
    assert.deepEqual(reasons.list(), [
      { code: 'content-unknown', records: 2 }, { code: 'date-unknown', records: 1 }, { code: 'not-covered', records: 1 },
    ]);
    assert.equal(reasons.size, 3);
    assert.ok(reasons.has('date-unknown') && !reasons.has('conflict'));
    const merged = new MetalsReasons().add('content-unknown', 'lot-b').add('conflict', 'order-c').addAll(reasons);
    assert.deepEqual(merged.list().map((reason) => [reason.code, reason.records]), [
      ['content-unknown', 2], ['conflict', 1], ['date-unknown', 1], ['not-covered', 1],
    ]);
    assert.deepEqual([...METALS_COMPLETENESS_CODES], [
      'content-unknown', 'unmatched-sales', 'cost-estimated', 'cost-unattributed', 'conflict', 'date-unknown', 'price-missing', 'price-stale',
      'source-held', 'not-covered',
    ]);
  });
});
