// Which statements a sync fetches: the history window and the open period, and any statement this receiver read on or
// just after its closing date, which is read again until it has been read after it settled.
import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeRanges, planStatements, readAfterSettling, recordReads, STATEMENT_SETTLE_DAYS } from '../lib/plan.mjs';

const PERIODS = [
  { start: '2026-04-15', end: '2026-05-14' }, { start: '2026-05-15', end: '2026-06-14' }, { start: '2026-06-15', end: '2026-07-14' },
  { start: '2026-07-15', end: '2026-08-14' }, { start: '2026-08-15', end: '2026-09-14' }, { start: '2026-09-15', end: '2026-10-14' },
];
const fetched = (plan) => plan.fetch.map((period) => [period.end, period.open]);
/** Reads of each statement closing on one of `ends`, made on `readOn`. */
const readsOf = (ends, readOn, empty = false) => Object.fromEntries(ends.map((end) => [end, { readOn, empty }]));

test('planning: the first sync fetches the history window and the open period, later syncs start at the first statement not done', () => {
  const first = planStatements({ periods: PERIODS, today: '2026-09-10', history: 3 });
  assert.deepEqual(fetched(first), [['2026-06-14', false], ['2026-07-14', false], ['2026-08-14', false], ['2026-09-14', true]],
    'a period that has not started yet is not fetched');
  assert.deepEqual(first.coverage, { start: '2026-05-15', end: '2026-09-10' }, 'the open period counts up to today');
  assert.equal(first.listedFrom, '2026-05-14');
  const reads = readsOf(['2026-05-14', '2026-06-14', '2026-07-14', '2026-08-14'], '2026-09-10');
  const later = planStatements({ periods: PERIODS, today: '2026-09-10', history: 3, known: [{ start: '2026-04-15', end: '2026-07-14' }], reads });
  assert.deepEqual(fetched(later), [['2026-08-14', false], ['2026-09-14', true]]);
  assert.equal(later.alreadyCovered, 2);
  // A gap is fetched again together with everything after it, so the file's dates are contiguous.
  const gap = [{ start: '2026-05-15', end: '2026-06-14' }, { start: '2026-07-15', end: '2026-08-14' }];
  assert.deepEqual(fetched(planStatements({ periods: PERIODS, today: '2026-09-10', history: 3, known: gap, reads })),
    [['2026-07-14', false], ['2026-08-14', false], ['2026-09-14', true]]);
  // Missing start dates are the day after the previous statement closed.
  const noStarts = planStatements({ periods: PERIODS.map(({ end }) => ({ start: null, end })), today: '2026-09-10', history: 2 });
  assert.deepEqual(noStarts.coverage, { start: '2026-06-15', end: '2026-09-10' });
  assert.equal(planStatements({ periods: [{ start: null, end: '2026-09-14' }], today: '2026-09-10', history: 3 }).coverage, null);
  assert.throws(() => planStatements({ periods: [{ start: '2026-09-15', end: '2026-09-14' }], today: '2026-09-10', history: 3 }), /valid statement dates/);
  assert.throws(() => planStatements({ periods: [], today: '2026-09-10', history: 3 }), /valid statement dates/);
  assert.deepEqual(mergeRanges([{ start: '2026-02-01', end: '2026-02-28' }, { start: '2026-01-01', end: '2026-01-31' }, { start: '2026-03-02', end: '2026-03-31' }]),
    [{ start: '2026-01-01', end: '2026-02-28' }, { start: '2026-03-02', end: '2026-03-31' }]);
});

test('a statement synced on its closing date is fetched again after it closes, until a read made once it settled', () => {
  // On its closing date the statement is still the open period: the file covers it up to today, the closing date.
  const closingDay = planStatements({ periods: PERIODS, today: '2026-09-14', history: 3 });
  assert.deepEqual(fetched(closingDay), [['2026-06-14', false], ['2026-07-14', false], ['2026-08-14', false], ['2026-09-14', true]]);
  assert.deepEqual(closingDay.coverage, { start: '2026-05-15', end: '2026-09-14' });
  let reads = recordReads({}, closingDay.fetch.map(({ end }) => ({ end, empty: false })), '2026-09-14', closingDay.listedFrom);
  // Holdr now holds every date of the statement; the converter even widened the file to a row dated the next day.
  const known = [{ start: '2026-05-15', end: '2026-09-15' }];
  const syncOn = (today) => {
    const plan = planStatements({ periods: PERIODS, today, history: 3, known, reads });
    reads = recordReads(reads, plan.fetch.map(({ end }) => ({ end, empty: false })), today, plan.listedFrom);
    return fetched(plan);
  };
  assert.deepEqual(syncOn('2026-09-15'), [['2026-09-14', false], ['2026-10-14', true]], 'rows of the closing date may have posted since');
  assert.deepEqual(syncOn('2026-09-16'), [['2026-09-14', false], ['2026-10-14', true]]);
  assert.equal(STATEMENT_SETTLE_DAYS, 3);
  assert.deepEqual(syncOn('2026-09-17'), [['2026-09-14', false], ['2026-10-14', true]], 'this read, three days after closing, settles it');
  assert.deepEqual(syncOn('2026-09-18'), [['2026-10-14', true]]);
  assert.deepEqual(syncOn('2026-09-30'), [['2026-10-14', true]]);
});

test('an early read is honoured however long the next sync waits, even beyond the history window', () => {
  const early = readsOf(['2026-07-14', '2026-08-14'], '2026-09-01');
  const closing = { ...early, '2026-09-14': { readOn: '2026-09-14', empty: false } };
  const known = [{ start: '2026-06-15', end: '2026-09-14' }];
  assert.deepEqual(fetched(planStatements({ periods: PERIODS, today: '2026-10-05', history: 3, known, reads: closing })),
    [['2026-09-14', false], ['2026-10-14', true]], 'three weeks later');
  // With one statement of history, the window still reaches back to the statement read too early.
  const older = { ...readsOf(['2026-07-14'], '2026-09-01'), '2026-08-14': { readOn: '2026-08-14', empty: false } };
  assert.deepEqual(fetched(planStatements({ periods: PERIODS, today: '2026-09-20', history: 1, known, reads: older })),
    [['2026-08-14', false], ['2026-09-14', false], ['2026-10-14', true]]);
  assert.deepEqual(fetched(planStatements({ periods: PERIODS, today: '2026-09-20', history: 1, known, reads: { ...older, '2026-08-14': { readOn: '2026-08-17', empty: false } } })),
    [['2026-09-14', false], ['2026-10-14', true]], 'once settled, the history window applies again');
});

test('a closed statement is done only when a read made after it settled is in Holdr or the outbox, or found nothing', () => {
  const today = '2026-09-10';
  const known = [{ start: '2026-05-15', end: '2026-08-14' }];
  const settled = readsOf(['2026-06-14', '2026-07-14', '2026-08-14'], '2026-08-20');
  assert.deepEqual(fetched(planStatements({ periods: PERIODS, today, history: 3, known, reads: settled })), [['2026-09-14', true]]);
  // Dates Holdr holds without a read by this receiver (a file imported by hand, perhaps exported on a closing date) are read once.
  assert.deepEqual(fetched(planStatements({ periods: PERIODS, today, history: 3, known, reads: {} })),
    [['2026-06-14', false], ['2026-07-14', false], ['2026-08-14', false], ['2026-09-14', true]]);
  // The file was deleted without being imported: its dates are not known any more, so the statements are read again.
  assert.deepEqual(fetched(planStatements({ periods: PERIODS, today, history: 3, known: [], reads: settled })),
    [['2026-06-14', false], ['2026-07-14', false], ['2026-08-14', false], ['2026-09-14', true]]);
  // A statement without transactions has nothing to import: a settled read of it is enough, an early one is not.
  const quiet = { ...settled, '2026-06-14': { readOn: '2026-08-20', empty: true } };
  assert.deepEqual(fetched(planStatements({ periods: PERIODS, today, history: 3, known: [{ start: '2026-06-15', end: '2026-08-14' }], reads: quiet })),
    [['2026-09-14', true]]);
  const quietEarly = { ...settled, '2026-08-14': { readOn: '2026-08-14', empty: true } };
  assert.deepEqual(fetched(planStatements({ periods: PERIODS, today, history: 3, known, reads: quietEarly })),
    [['2026-08-14', false], ['2026-09-14', true]]);
});

test('reads are recorded per closing date, replacing older reads and forgetting statements the issuer no longer lists', () => {
  assert.equal(readAfterSettling('2026-09-14', '2026-09-16'), false);
  assert.equal(readAfterSettling('2026-09-14', '2026-09-17'), true);
  assert.equal(readAfterSettling('2026-01-30', '2026-02-02'), true, 'across a month end');
  assert.equal(readAfterSettling('2026-09-14', 'not a date'), false);
  const before = { '2026-01-14': { readOn: '2026-01-20', empty: false }, '2026-09-14': { readOn: '2026-09-14', empty: false } };
  assert.deepEqual(recordReads(before, [{ end: '2026-09-14', empty: false }, { end: '2026-10-14', empty: true }], '2026-09-20', '2026-05-14'), {
    '2026-09-14': { readOn: '2026-09-20', empty: false },
    '2026-10-14': { readOn: '2026-09-20', empty: true },
  });
  assert.deepEqual(before['2026-09-14'], { readOn: '2026-09-14', empty: false }, 'the previous record is not changed in place');
});
