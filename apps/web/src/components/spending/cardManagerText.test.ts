import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardAccount, CardAccountCoverage } from '@finance-tracker/shared';

import {
  CARD_MANAGER_LEAD,
  CLOSING_DETAIL,
  STATUS_KEEPS,
  cardManagerCountText,
  cardManagerRows,
  cardStatusText,
  issuerChoices,
  latestRecorded,
  latestRecordedText,
  ownerChoices,
  statusChangedText,
  statusConfirmation,
} from './cardManagerText';

// Synthetic cards and dates only.
function account(id: string, patch: Partial<CardAccount> = {}): CardAccount {
  return {
    id, issuer: 'amex', owner: 'alex', nickname: `Sample ${id}`, last4: '0001', currency: 'USD', status: 'active',
    createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', ...patch,
  };
}
function coverage(cardAccountId: string, ranges: Array<[string, string]>, last?: string): CardAccountCoverage {
  return {
    cardAccountId,
    ranges: ranges.map(([start, end]) => ({ start, end })),
    transactions: last === undefined ? null : { count: 3, first: '2023-01-05', last },
    imports: [],
  };
}

test('the latest day recorded is the later of the last row and the end of the imported coverage, never guessed', () => {
  assert.equal(latestRecorded(coverage('a', [['2024-01-01', '2024-01-31'], ['2024-03-01', '2024-03-31']], '2024-03-20')), '2024-03-31');
  assert.equal(latestRecorded(coverage('a', [['2024-01-01', '2024-01-31']], '2024-02-14')), '2024-02-14');
  // Any order of ranges: the latest end counts.
  assert.equal(latestRecorded(coverage('a', [['2024-05-01', '2024-05-31'], ['2024-01-01', '2024-01-31']])), '2024-05-31');
  assert.equal(latestRecorded(coverage('a', [], '2023-07-04')), '2023-07-04');
  assert.equal(latestRecorded(coverage('a', [])), null);
  assert.equal(latestRecorded({ ranges: [{ start: 'x', end: 'not a day' }], transactions: null }), null);
  assert.equal(latestRecordedText('2024-03-31'), 'Latest recorded Mar 31, 2024');
  assert.equal(latestRecordedText(null), 'Nothing recorded');
});

test('lists every card oldest activity first, then the cards with nothing recorded, then any not read, ties by name', () => {
  const cards = [
    account('recent', { nickname: 'Recent' }),
    account('old', { nickname: 'Old' }),
    account('empty', { nickname: 'Empty' }),
    account('tie-b', { nickname: 'Tie B' }),
    account('tie-a', { nickname: 'Tie A' }),
    account('unread', { nickname: 'Unread' }),
  ];
  const read = [
    coverage('recent', [['2024-05-01', '2024-05-31']], '2024-05-30'),
    coverage('old', [['2023-01-01', '2023-01-31']], '2023-01-29'),
    coverage('empty', []),
    coverage('tie-b', [], '2023-06-30'),
    coverage('tie-a', [['2023-06-01', '2023-06-30']]),
  ];
  const rows = cardManagerRows(cards, read, { issuer: '', owner: '' });
  assert.deepEqual(rows.map((row) => [row.account.id, row.latest]), [
    ['old', '2023-01-31'], ['tie-a', '2023-06-30'], ['tie-b', '2023-06-30'], ['recent', '2024-05-31'], ['empty', null], ['unread', undefined],
  ]);
});

test('until the record is read, every card is listed by name with its latest day unknown', () => {
  const rows = cardManagerRows([account('b', { nickname: 'Beta' }), account('a', { nickname: 'Alpha' })], null, { issuer: '', owner: '' });
  assert.deepEqual(rows.map((row) => [row.account.id, row.latest]), [['a', undefined], ['b', undefined]]);
});

test('narrows by issuer and person, and offers only the issuers and people who have cards', () => {
  const cards = [
    account('w-amex', { owner: 'alex' }),
    account('x-chase', { issuer: 'chase', owner: 'casey' }),
    account('x-amex', { owner: 'casey', status: 'closed' }),
    account('w-wf', { issuer: 'wells-fargo', owner: 'alex' }),
  ];
  const read = cards.map((card) => coverage(card.id, [], '2024-01-10'));
  const ids = (issuer: string, owner: '' | 'alex' | 'casey' | 'joint') => cardManagerRows(cards, read, { issuer, owner }).map((row) => row.account.id).sort();
  assert.deepEqual(ids('amex', ''), ['w-amex', 'x-amex']);
  assert.deepEqual(ids('', 'casey'), ['x-amex', 'x-chase']);
  assert.deepEqual(ids('amex', 'casey'), ['x-amex']);
  assert.deepEqual(ids('chase', 'alex'), []);
  assert.deepEqual(issuerChoices(cards), [
    { value: 'amex', label: 'Amex' }, { value: 'chase', label: 'Chase' }, { value: 'wells-fargo', label: 'Wells Fargo' },
  ]);
  assert.deepEqual(ownerChoices(cards), [{ value: 'alex', label: 'Alex' }, { value: 'casey', label: 'Casey' }]);
});

test('says how many cards are shown, of all, and in what order', () => {
  assert.equal(cardManagerCountText(12, 12, true), '12 cards, oldest activity first');
  assert.equal(cardManagerCountText(3, 12, true), '3 of 12 cards, oldest activity first');
  assert.equal(cardManagerCountText(1, 1, false), '1 card, by name');
  assert.equal(cardManagerCountText(0, 4, true), '0 of 4 cards, oldest activity first');
});

test('a status is Holdr\'s only, and each confirmation says what changes and what does not', () => {
  assert.equal(CARD_MANAGER_LEAD, 'Holdr never closes a card by itself. History stays.');
  assert.equal(cardStatusText('active'), 'Active');
  assert.equal(cardStatusText('closed'), 'Closed in Holdr');
  const closing = statusConfirmation('active');
  assert.equal(closing.title, 'Mark card closed in Holdr?');
  assert.equal(closing.action, 'Mark closed');
  assert.equal(closing.lines[0], 'Later history is no longer expected after this card\'s last recorded activity or imported coverage; earlier gaps may remain.');
  assert.equal(closing.lines[0], CLOSING_DETAIL);
  assert.ok(closing.lines.includes(STATUS_KEEPS));
  assert.match(STATUS_KEEPS, /not your account at the bank\.$/);
  const reopening = statusConfirmation('closed');
  assert.equal(reopening.title, 'Reopen card in Holdr?');
  assert.equal(reopening.action, 'Reopen card');
  assert.deepEqual(reopening.lines, ['This puts the card back in the active list.', 'Holdr expects this card\'s history again through today.', STATUS_KEEPS]);
  // No bank closure date is ever claimed, and nothing is said to have been refreshed.
  for (const line of [...closing.lines, ...reopening.lines]) assert.doesNotMatch(line, /\d{4}|closed on|refresh/i);
});

test('the notice after a change names the card and keeps every transaction, without claiming the figures were refreshed', () => {
  assert.equal(statusChangedText('Amex Sample ··0001 · Alex', 'closed'), 'Amex Sample ··0001 · Alex is marked closed. All transactions are retained.');
  assert.equal(statusChangedText('Amex Sample ··0001 · Alex', 'active'), 'Amex Sample ··0001 · Alex is active again. All transactions are retained.');
  assert.doesNotMatch(statusChangedText('X', 'closed'), /refresh|chart|updated/i);
});
