import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { easternDate, endOfEasternDay, startOfEasternDay } from './dates.js';
import { predictCycleDates } from './predict.js';

describe('Eastern dates', () => {
  it('midnight, DST and the last millisecond of a day', () => {
    assert.equal(new Date(startOfEasternDay('2026-10-13')).toISOString(), '2026-10-13T04:00:00.000Z');
    assert.equal(new Date(startOfEasternDay('2026-11-03')).toISOString(), '2026-11-03T05:00:00.000Z');
    assert.equal(new Date(endOfEasternDay('2026-11-01')).toISOString(), '2026-11-02T04:59:59.999Z');
    assert.equal(new Date(startOfEasternDay('2026-03-08')).toISOString(), '2026-03-08T05:00:00.000Z');
    assert.equal(new Date(endOfEasternDay('2026-03-08')).toISOString(), '2026-03-09T03:59:59.999Z');
    assert.equal(easternDate('2026-10-14T03:59:59.999Z'), '2026-10-13');
    assert.equal(easternDate('2026-10-14T04:00:00.000Z'), '2026-10-14');
    assert.equal(easternDate('2026-11-02T04:59:59.999Z'), '2026-11-01');
    assert.equal(easternDate('2026-11-02T05:00:00.000Z'), '2026-11-02');
    assert.equal(easternDate('2028-03-01T04:59:00.000Z'), '2028-02-29');
  });
});

describe('predictCycleDates', () => {
  it('a fixed closing day and a fixed grace: the next close and due date', () => {
    const history = [
      { closingDate: '2026-06-12', dueDate: '2026-07-07' },
      { closingDate: '2026-07-12', dueDate: '2026-08-06' },
      { closingDate: '2026-08-12', dueDate: '2026-09-06' },
    ];
    // Close on the 12th (no weekend shift: July 12 is a Sunday), due 25 days later; no fixed due day fits all three.
    assert.deepEqual(predictCycleDates(history), { closingDate: '2026-09-12', dueDate: '2026-10-07', predicted: true });
    assert.deepEqual(predictCycleDates([...history, { closingDate: '2026-09-12', dueDate: '2026-10-07' }]),
      { closingDate: '2026-10-12', dueDate: '2026-11-06', predicted: true });
  });

  it('a weekend rule on the close, and a fixed due day of the next month', () => {
    // Feb 13 moved back from Sunday Feb 15, but Mar 16 is not Mar 15 moved: no single rule explains the run.
    assert.equal(predictCycleDates([
      { closingDate: '2026-01-16', dueDate: '2026-02-10' },
      { closingDate: '2026-02-13', dueDate: '2026-03-10' },
      { closingDate: '2026-03-16', dueDate: '2026-04-10' },
      { closingDate: '2026-04-16', dueDate: '2026-05-10' },
    ]), null);
    // The 15th, moved back to Friday on weekends; due on the 10th of the next month.
    const back = [
      { closingDate: '2026-01-15', dueDate: '2026-02-10' },
      { closingDate: '2026-02-13', dueDate: '2026-03-10' },
      { closingDate: '2026-03-13', dueDate: '2026-04-10' },
      { closingDate: '2026-04-15', dueDate: '2026-05-10' },
    ];
    assert.deepEqual(predictCycleDates(back), { closingDate: '2026-05-15', dueDate: '2026-06-10', predicted: true });
  });

  it('needs at least three consecutive months, and a gap breaks the run', () => {
    assert.equal(predictCycleDates([{ closingDate: '2026-06-12', dueDate: '2026-07-07' }, { closingDate: '2026-07-12', dueDate: '2026-08-06' }]), null);
    assert.equal(predictCycleDates([
      { closingDate: '2026-04-12', dueDate: '2026-05-07' },
      { closingDate: '2026-06-12', dueDate: '2026-07-07' },
      { closingDate: '2026-07-12', dueDate: '2026-08-06' },
    ]), null);
    assert.equal(predictCycleDates([
      { closingDate: '2026-06-12', dueDate: null },
      { closingDate: '2026-07-12', dueDate: '2026-08-06' },
      { closingDate: '2026-08-12', dueDate: '2026-09-06' },
    ]), null);
  });

  it('month-end closes clamp to the month\'s last day', () => {
    const history = [
      { closingDate: '2026-01-31', dueDate: '2026-02-25' },
      { closingDate: '2026-02-28', dueDate: '2026-03-25' },
      { closingDate: '2026-03-31', dueDate: '2026-04-25' },
      { closingDate: '2026-04-30', dueDate: '2026-05-25' },
    ];
    const prediction = predictCycleDates(history);
    assert.deepEqual(prediction, { closingDate: '2026-05-31', dueDate: '2026-06-25', predicted: true });
  });
});
