import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Quote } from '@finance-tracker/shared';

import { SYNTHETIC_QUOTES_NOTE, quoteBadge } from './quoteStatus';

const NOW = Date.parse('2026-10-20T18:00:00Z');
const quote = (symbol: string, over: Partial<Quote> = {}): Quote => ({
  symbol, price: 100, currency: 'USD', asOf: NOW - 3 * 3_600_000, source: 'nasdaq', freshness: 'eod', session: 'closed', ...over,
});
const firstLine = (title: string) => title.split('\n')[0];

test('the demo\'s stored prices read "Synthetic", whatever their session or age, and the tooltip says they are invented', () => {
  assert.match(SYNTHETIC_QUOTES_NOTE, /invented demo data/);
  for (const over of [
    { freshness: 'live', session: 'regular' }, { freshness: 'stale', session: 'regular' }, { freshness: 'eod', session: 'closed' },
    { freshness: 'delayed', session: 'pre-market' },
  ] as const) {
    const badge = quoteBadge([quote('VTI', { source: 'synthetic', ...over }), quote('QQQ', { source: 'synthetic', ...over })],
      ['VTI', 'QQQ'], NOW);
    assert.deepEqual([badge.kind, badge.text], ['synthetic', 'Synthetic'], over.freshness);
    assert.deepEqual(badge.title.split('\n').slice(0, 2), ['Synthetic · 3h ago', SYNTHETIC_QUOTES_NOTE]);
  }
});

test('a held symbol without a stored price still makes synthetic quotes "Partial"', () => {
  const badge = quoteBadge([quote('VTI', { source: 'synthetic', freshness: 'stale', session: 'regular' })], ['VTI', 'NBIS'], NOW);
  assert.deepEqual([badge.kind, badge.text, firstLine(badge.title)], ['delayed', 'Partial 1', 'Partial · 3h ago · Synthetic']);
  const lines = badge.title.split('\n');
  assert.ok(lines.includes(SYNTHETIC_QUOTES_NOTE));
  assert.equal(lines.at(-1), 'Missing: NBIS');
});

test('market quotes keep their session labels and sources; an unknown source is still "Cached"', () => {
  const live = quoteBadge([quote('VTI', { freshness: 'live', session: 'regular', asOf: NOW })], ['VTI'], NOW);
  assert.deepEqual([live.kind, live.text, live.title.split('\n').slice(0, 2)],
    ['live', 'Live', ['Live · just now · Nasdaq', 'session=regular · freshness=live']]);
  assert.equal(quoteBadge([quote('VTI', { freshness: 'stale', session: 'regular' })], ['VTI'], NOW).text, 'Stale');
  for (const source of [undefined, 'cache', 'unknown'] as const) {
    const badge = quoteBadge([quote('VTI', { source })], ['VTI'], NOW);
    assert.deepEqual([badge.kind, badge.text, firstLine(badge.title)], ['eod', 'Closed', 'Closed · 3h ago · Cached'], source);
  }
  assert.equal(firstLine(quoteBadge([quote('VTI'), quote('QQQ', { source: 'stooq' })], ['VTI', 'QQQ'], NOW).title), 'Closed · 3h ago · Mixed');
  assert.deepEqual(quoteBadge([], ['VTI'], NOW), { kind: null, text: 'No quotes', title: 'No quotes\nMissing: VTI' });
});
