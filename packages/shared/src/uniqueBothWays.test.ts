import { test } from 'node:test';
import assert from 'node:assert/strict';

import { uniqueBothWays } from './uniqueBothWays.js';

// Synthetic subject and row keys only.
const edge = (subject: string, row: string) => ({ subject, row });

test('the one-to-one rule links a subject to its one candidate row when no other subject claims it', () => {
  const rule = uniqueBothWays([edge('s1', 'r1')]);
  assert.equal(rule.linked('s1'), 'r1');
  assert.equal(rule.candidates('s1'), 1);
  assert.equal(rule.degree('r1'), 1);
});

test('the one-to-one rule links no subject with two candidate rows, and no row it could be', () => {
  const rule = uniqueBothWays([edge('s1', 'r1'), edge('s1', 'r2')]);
  assert.equal(rule.linked('s1'), null);
  assert.equal(rule.candidates('s1'), 2);
  assert.deepEqual([rule.degree('r1'), rule.degree('r2')], [1, 1]);
});

test('the one-to-one rule links neither of two subjects that claim one row', () => {
  const rule = uniqueBothWays([edge('s1', 'r1'), edge('s2', 'r1')]);
  assert.equal(rule.linked('s1'), null);
  assert.equal(rule.linked('s2'), null);
  assert.equal(rule.degree('r1'), 2);
  assert.deepEqual([rule.candidates('s1'), rule.candidates('s2')], [1, 1]);
});

test('the one-to-one rule counts an edge given twice twice', () => {
  const rule = uniqueBothWays([edge('s1', 'r1'), edge('s1', 'r1')]);
  assert.equal(rule.linked('s1'), null);
  assert.equal(rule.candidates('s1'), 2);
  assert.equal(rule.degree('r1'), 2);
});

test('the one-to-one rule decides each subject on its own: a contested row holds only the subjects that claim it', () => {
  const rule = uniqueBothWays([edge('s1', 'r1'), edge('s2', 'r1'), edge('s2', 'r2'), edge('s3', 'r3')]);
  assert.deepEqual(['s1', 's2', 's3'].map((subject) => rule.linked(subject)), [null, null, 'r3']);
  assert.deepEqual(['r1', 'r2', 'r3'].map((row) => rule.degree(row)), [2, 1, 1]);
});

test('the one-to-one rule says 0 and null for a subject or a row no edge names', () => {
  const rule = uniqueBothWays([]);
  assert.equal(rule.linked('s9'), null);
  assert.equal(rule.candidates('s9'), 0);
  assert.equal(rule.degree('r9'), 0);
});
