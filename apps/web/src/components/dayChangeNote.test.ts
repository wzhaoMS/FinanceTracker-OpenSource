import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dayChangeNote } from './dayChangeNote';

test('a 24-hour change says so, in full and as the ticker\'s short "24h", whatever the session', () => {
  for (const session of ['pre-market', 'regular', 'after-hours', 'closed', undefined] as const) {
    assert.deepEqual(dayChangeNote({ changeBasis: '24h', freshness: 'live', session }), { text: '24-hour change', short: '24h' });
  }
});

test('a provider\'s change reads "approximate", whatever the session', () => {
  for (const session of ['pre-market', 'regular', 'after-hours', 'closed', undefined] as const) {
    assert.deepEqual(dayChangeNote({ changeBasis: 'provider', freshness: 'delayed', session }), { text: 'approximate', short: 'approximate' });
  }
});

test('a change against the prior close names the extended session it is measured in', () => {
  assert.deepEqual(dayChangeNote({ changeBasis: 'previousClose', freshness: 'live', session: 'pre-market' }), { text: 'pre-market', short: 'pre-market' });
  assert.deepEqual(dayChangeNote({ changeBasis: 'previousClose', freshness: 'live', session: 'after-hours' }), { text: 'after hours', short: 'after hours' });
});

test('the regular session against the prior close, the brokerage default, has no note', () => {
  for (const session of ['regular', 'closed', undefined] as const) {
    assert.equal(dayChangeNote({ changeBasis: 'previousClose', freshness: 'live', session }), null);
    assert.equal(dayChangeNote({ changeBasis: 'previousClose', freshness: 'eod', session }), null);
  }
});

test('a change the holdings don\'t show has no note, in extended hours too: no basis, a stale quote, or from the open', () => {
  for (const session of ['pre-market', 'after-hours'] as const) {
    assert.equal(dayChangeNote({ freshness: 'live', session }), null);
    assert.equal(dayChangeNote({ changeBasis: 'previousClose', freshness: 'stale', session }), null);
    assert.equal(dayChangeNote({ changeBasis: '24h', freshness: 'stale', session }), null);
    assert.equal(dayChangeNote({ changeBasis: 'open', freshness: 'live', session }), null);
  }
  assert.equal(dayChangeNote({}), null);
});

test('the holdings\' basis, already cleared for display, gets the same note without its freshness', () => {
  assert.deepEqual(dayChangeNote({ changeBasis: 'previousClose', session: 'after-hours' }), { text: 'after hours', short: 'after hours' });
  assert.deepEqual(dayChangeNote({ changeBasis: '24h', session: 'regular' }), { text: '24-hour change', short: '24h' });
  assert.equal(dayChangeNote({ changeBasis: undefined, session: 'after-hours' }), null);
});
