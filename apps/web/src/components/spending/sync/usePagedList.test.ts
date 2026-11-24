import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeById } from './usePagedList';

test('a member a later page serves again is shown once, as the later page has it; new ones are appended (E1b revision 8, X39)', () => {
  const key = (item: { id: string; reason: string }) => item.id;
  const first = [{ id: 'a', reason: 'superseded' }, { id: 'b', reason: 'superseded' }];
  // `a` was separated and merged again meanwhile: a new key brings it back on the next page, with what it is now.
  const later = [{ id: 'c', reason: 'superseded' }, { id: 'a', reason: 'settled-into' }];
  assert.deepEqual(mergeById(first, later, key), [
    { id: 'a', reason: 'settled-into' }, { id: 'b', reason: 'superseded' }, { id: 'c', reason: 'superseded' },
  ]);
  assert.deepEqual(first, [{ id: 'a', reason: 'superseded' }, { id: 'b', reason: 'superseded' }], 'the earlier list is left as it was');
});
