import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EMPTY_GOAL, GOAL_KEY, readGoal, writeGoal } from './performanceGoal';

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  };
}

test('a browser that never set a goal has none: no default target', () => {
  assert.equal(readGoal(memoryStorage()), null);
  assert.equal(readGoal(null), null);
});

test('a goal someone set is read back as it was entered', () => {
  const goal = { target: '1500000', by: '2040-06-30', yearlyAdded: '' };
  assert.deepEqual(readGoal(memoryStorage({ [GOAL_KEY]: JSON.stringify(goal) })), goal);
});

test('blanks, malformed JSON and other shapes are no goal', () => {
  for (const stored of [JSON.stringify(EMPTY_GOAL), JSON.stringify({ target: ' ', by: '', yearlyAdded: '' }), '{', '"goal"',
    JSON.stringify({ target: 1500000, by: '2040-06-30', yearlyAdded: '' }), JSON.stringify({ target: '1500000', by: '2040-06-30' })]) {
    assert.equal(readGoal(memoryStorage({ [GOAL_KEY]: stored })), null, stored);
  }
  const unreadable = { ...memoryStorage(), getItem: () => { throw new Error('denied'); } };
  assert.equal(readGoal(unreadable), null);
});

test('saving keeps a goal with something in it, and removing it (or blanking every field) leaves no goal stored', () => {
  const storage = memoryStorage();
  writeGoal(storage, EMPTY_GOAL);
  assert.equal(storage.items.has(GOAL_KEY), false, 'opening the form stores nothing');
  const goal = { target: '', by: '2040-06-30', yearlyAdded: '' };
  writeGoal(storage, goal);
  assert.deepEqual(readGoal(storage), goal);
  writeGoal(storage, null);
  assert.equal(storage.items.has(GOAL_KEY), false);
  writeGoal(storage, { target: '1500000', by: '2040-06-30', yearlyAdded: '' });
  writeGoal(storage, EMPTY_GOAL);
  assert.equal(storage.items.has(GOAL_KEY), false);
});
