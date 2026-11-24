import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addMonths, daysBetween, isBenefitDate } from './dates.js';
import { benefitSpanContaining, benefitSpansBetween, benefitYearSpans, cadenceLabel } from './periods.js';

const spans = (value: ReturnType<typeof benefitYearSpans>) => value?.map(({ start, end, label }) => `${start}..${end} ${label}`);

describe('benefit dates', () => {
  it('accepts only real calendar dates', () => {
    assert.equal(isBenefitDate('2028-02-29'), true);
    for (const value of ['2027-02-29', '2026-13-01', '2026-1-01', '2026-01-01T00:00:00Z', 20260101, null]) {
      assert.equal(isBenefitDate(value), false, String(value));
    }
  });

  it('counts days and months in plain calendar arithmetic', () => {
    assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
    assert.equal(daysBetween('2026-03-08', '2026-03-01'), -7);
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2024-08-31', 54), '2029-02-28');
    assert.equal(addMonths('2026-05-15', -48), '2022-05-15');
  });
});

describe('benefit periods', () => {
  it('splits a calendar year into months, quarters, halves or the year itself', () => {
    const months = benefitYearSpans({ every: 'month', basis: 'calendar' }, 2028, null)!;
    assert.equal(months.length, 12);
    assert.deepEqual(spans([months[1], months[11]]), ['2028-02-01..2028-02-29 Feb', '2028-12-01..2028-12-31 Dec']);
    assert.deepEqual(spans(benefitYearSpans({ every: 'quarter', basis: 'calendar' }, 2026, 7)), [
      '2026-01-01..2026-03-31 Q1', '2026-04-01..2026-06-30 Q2', '2026-07-01..2026-09-30 Q3', '2026-10-01..2026-12-31 Q4',
    ]);
    assert.deepEqual(spans(benefitYearSpans({ every: 'half', basis: 'calendar' }, 2026, null)), [
      '2026-01-01..2026-06-30 Jan–Jun', '2026-07-01..2026-12-31 Jul–Dec',
    ]);
    assert.deepEqual(spans(benefitYearSpans({ every: 'year', basis: 'calendar' }, 2026, 5)), ['2026-01-01..2026-12-31 2026']);
  });

  it('starts cardmember periods in the anniversary month, and needs it', () => {
    assert.deepEqual(spans(benefitYearSpans({ every: 'year', basis: 'cardmember' }, 2026, 3)), ['2026-03-01..2027-02-28 Mar 2026 – Feb 2027']);
    assert.deepEqual(spans(benefitYearSpans({ every: 'year', basis: 'cardmember' }, 2026, 1)), ['2026-01-01..2026-12-31 Jan 2026 – Dec 2026']);
    assert.deepEqual(spans(benefitYearSpans({ every: 'half', basis: 'cardmember' }, 2026, 11)), [
      '2026-11-01..2027-04-30 Nov–Apr', '2027-05-01..2027-10-31 May–Oct',
    ]);
    for (const month of [null, 0, 13, 2.5]) {
      assert.equal(benefitYearSpans({ every: 'year', basis: 'cardmember' }, 2026, month), null, String(month));
    }
  });

  it('shows a once-per-several-years credit by calendar year', () => {
    assert.deepEqual(spans(benefitYearSpans({ every: 'years', months: 48 }, 2026, null)), ['2026-01-01..2026-12-31 2026']);
  });

  it('finds the period containing a date and the periods between two dates', () => {
    assert.deepEqual(spans([benefitSpanContaining({ every: 'year', basis: 'cardmember' }, '2026-02-10', 3)!]), [
      '2025-03-01..2026-02-28 Mar 2025 – Feb 2026',
    ]);
    assert.deepEqual(spans([benefitSpanContaining({ every: 'quarter', basis: 'calendar' }, '2026-12-31', null)!]), ['2026-10-01..2026-12-31 Q4']);
    assert.deepEqual(spans(benefitSpansBetween({ every: 'month', basis: 'calendar' }, '2025-12-31', '2026-02-01', null)), [
      '2025-12-01..2025-12-31 Dec', '2026-01-01..2026-01-31 Jan', '2026-02-01..2026-02-28 Feb',
    ]);
    assert.equal(benefitSpanContaining({ every: 'year', basis: 'cardmember' }, '2026-02-10', null), null);
  });

  it('names cadences for people', () => {
    assert.equal(cadenceLabel({ every: 'month', basis: 'calendar' }), 'Monthly');
    assert.equal(cadenceLabel({ every: 'half', basis: 'calendar' }), 'Twice a year');
    assert.equal(cadenceLabel({ every: 'year', basis: 'cardmember' }), 'Each cardmember year');
    assert.equal(cadenceLabel({ every: 'years', months: 48 }), 'Once every 4 years');
    assert.equal(cadenceLabel({ every: 'years', months: 54 }), 'Once every 4½ years');
  });
});
