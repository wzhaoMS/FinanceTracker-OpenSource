import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ISSUER_TRACKERS_PER_CALL,
  isIssuerBenefitId,
  isSafeIssuerTrackerName,
  validateIssuerBenefitTrackerSnapshots,
  type IssuerBenefitTrackerSnapshot,
} from './issuerTrackers.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');

function snapshot(patch: Record<string, unknown> = {}): IssuerBenefitTrackerSnapshot {
  return {
    issuer: 'amex', issuerBenefitId: 'sample-benefit.1', name: 'Sample Streaming Credit', periodStart: '2026-10-01',
    periodEnd: '2026-10-31', unit: 'money', currency: 'USD', usedMinor: 1000, totalMinor: 2500, resetDate: '2026-11-01',
    enrollment: 'enrolled', observedAt: '2026-10-19T11:58:00.000Z', ...patch,
  } as IssuerBenefitTrackerSnapshot;
}

const issues = (value: unknown) => {
  const result = validateIssuerBenefitTrackerSnapshots(value, NOW);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path} ${issue.code}`);
};

describe('issuer benefit tracker snapshots', () => {
  it('accepts well-formed snapshots, unknown figures as null', () => {
    const counted = snapshot({ issuerBenefitId: 'night', unit: 'count', currency: null, usedMinor: null, totalMinor: 1, enrollment: 'unknown' });
    const result = validateIssuerBenefitTrackerSnapshots([snapshot(), counted], NOW);
    assert.equal(result.ok, true);
    assert.deepEqual(issues([]), []);
  });

  it('names each bad field by path and code, never by value', () => {
    assert.deepEqual(issues(snapshot()), ['$ not-a-list']);
    assert.deepEqual(issues(Array.from({ length: MAX_ISSUER_TRACKERS_PER_CALL + 1 }, () => snapshot())), ['$ too-many']);
    assert.deepEqual(issues([null]), ['$[0] not-an-object']);
    assert.deepEqual(issues([{ ...snapshot(), extra: 1 }]), ['$[0] unexpected-key']);
    const { name: _dropped, ...withoutName } = snapshot();
    assert.deepEqual(issues([withoutName]), ['$[0].name missing', '$[0].name type']);
    assert.deepEqual(issues([snapshot({ issuer: 'samplebank' })]), ['$[0].issuer format']);
    assert.deepEqual(issues([snapshot({ issuerBenefitId: 'id with spaces' })]), ['$[0].issuerBenefitId format']);
    assert.deepEqual(issues([snapshot({ issuerBenefitId: 'benefit-12345' })]), ['$[0].issuerBenefitId format']);
    assert.deepEqual(issues([snapshot({ periodStart: '2026-02-30' })]), ['$[0].periodStart format']);
    assert.deepEqual(issues([snapshot({ periodEnd: '2026-09-30' })]), ['$[0].periodEnd range']);
    assert.deepEqual(issues([snapshot({ unit: 'points' })]), ['$[0].unit format']);
    assert.deepEqual(issues([snapshot({ currency: 'usd' })]), ['$[0].currency format']);
    assert.deepEqual(issues([snapshot({ unit: 'count', currency: 'USD' })]), ['$[0].currency format']);
    assert.deepEqual(issues([snapshot({ usedMinor: -1, totalMinor: 1.5 })]), ['$[0].usedMinor range', '$[0].totalMinor range']);
    assert.deepEqual(issues([snapshot({ resetDate: 'soon' })]), ['$[0].resetDate format']);
    assert.deepEqual(issues([snapshot({ enrollment: 'maybe' })]), ['$[0].enrollment format']);
    assert.deepEqual(issues([snapshot({ observedAt: '2026-10-19 11:58' })]), ['$[0].observedAt format']);
    assert.deepEqual(issues([snapshot({ observedAt: '2026-10-19T13:00:00.000Z' })]), ['$[0].observedAt future']);
    assert.deepEqual(issues([snapshot(), snapshot()]), ['$[1] duplicate']);
  });

  it('refuses card data and anything that is not plain display text in a name', () => {
    for (const name of ['Credit 4111 1111 1111 1111', 'Ending 12345', 'CVV 123 credit', 'Codes 1234 5678 9012 34']) {
      assert.deepEqual(issues([snapshot({ name })]), ['$[0].name card-data'], name);
    }
    for (const name of ['', '  Padded', 'Two  spaces', 'Tab\there', 'x'.repeat(81), 'Zero\u200bwidth']) {
      assert.deepEqual(issues([snapshot({ name })]), ['$[0].name format'], JSON.stringify(name));
    }
    assert.equal(isSafeIssuerTrackerName('Uber Cash $15 monthly'), true);
    assert.equal(isIssuerBenefitId('sample/benefit'), false);
    assert.equal(isIssuerBenefitId('Sample:Benefit-2026.Q4'), true);
  });

  it('refuses ids that could carry a card number or a secret, however they are grouped', () => {
    for (const issuerBenefitId of ['4111-1111-1111-1111', '4111.1111.1111.1111', 'CVV:123', 'id-1234-5678-9012-3']) {
      assert.deepEqual(issues([snapshot({ issuerBenefitId })]), ['$[0].issuerBenefitId card-data'], issuerBenefitId);
      assert.equal(isIssuerBenefitId(issuerBenefitId), false, issuerBenefitId);
    }
  });
});
