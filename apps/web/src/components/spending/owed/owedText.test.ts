import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { OwedCard, OwedRead } from './owedApi';
import {
  OWED_NOT_INSTALLED,
  owedAsOfText,
  owedCardAmount,
  owedCardDetails,
  owedCardFallbackName,
  owedCoverage,
  owedCoverageText,
  owedGroupAmount,
  owedGroupMeta,
  owedGroups,
  owedHeadline,
  owedHeldText,
  owedLeftOutText,
  owedNetText,
  owedTotals,
} from './owedText';

// Synthetic issuers, endings, dates and cents only.
const TODAY = '2026-11-22';
const read = (patch: Partial<OwedRead> = {}): OwedRead => ({
  currentBalanceMinor: null, conflict: false, asOf: `${TODAY}T15:00:00.000Z`, asOfDate: TODAY, sourceKind: 'issuer-dashboard-json',
  statementBalanceMinor: null, statementClosingDate: null, remainingStatementMinor: null, paymentDueDate: null, minimumDueMinor: null, ...patch,
});
const card = (id: string, patch: Partial<OwedCard> = {}): OwedCard => ({
  cardAccountId: id, issuer: 'testbank', owner: 'alex', nickname: null, last4: '0001', last5: null, currency: 'USD', status: 'active', read: null,
  ...patch,
});
const balance = (minor: number, patch: Partial<OwedRead> = {}) => read({ currentBalanceMinor: minor, ...patch });

/** A household's cards: two people, three issuers, credits, a disagreement, cards never read. */
const CARDS: OwedCard[] = [
  card('a1', { issuer: 'testbank', owner: 'alex', last4: '0101', read: balance(120_000) }),
  card('a2', { issuer: 'testbank', owner: 'alex', last4: '0102', read: balance(-50_000, { asOfDate: '2026-11-09' }) }),
  card('a3', { issuer: 'testbank', owner: 'alex', last4: '0103' }),
  card('b1', { issuer: 'otherbank', owner: 'casey', last4: '0201', read: balance(300_000) }),
  card('b2', { issuer: 'otherbank', owner: 'casey', last4: '0202', read: read({ conflict: true }) }),
  card('c1', { issuer: 'quietbank', owner: 'alex', last4: '0301' }),
  card('c2', { issuer: 'quietbank', owner: 'casey', last4: '0302', read: read({ statementBalanceMinor: 900 }) }),
];

test('totals owed, credits and net over the cards read only; a card not read or whose reads disagree is in none', () => {
  assert.deepEqual(owedTotals(CARDS), [{ currency: 'USD', owedMinor: 420_000, creditsMinor: -50_000, netMinor: 370_000, cards: 3 }]);
  assert.equal(owedHeadline(owedTotals(CARDS)), '$4,200.00 owed now');
  assert.equal(owedNetText(owedTotals(CARDS)), 'Credits −$500.00 · net $3,700.00');
  // A zero balance is read, owes nothing and holds no credit.
  assert.equal(owedNetText(owedTotals([card('z', { read: balance(0) })])), 'No credits · net $0.00');
  // Each currency apart, never added together; the currency with more cards first.
  const mixed = owedTotals([...CARDS, card('e1', { currency: 'EUR', read: balance(1_200) })]);
  assert.deepEqual(mixed.map((item) => [item.currency, item.owedMinor, item.cards]), [['USD', 420_000, 3], ['EUR', 1_200, 1]]);
  assert.equal(owedHeadline(mixed), '$4,200.00 and €12.00 owed now');
  // Nothing read: nothing totalled, and that is said rather than $0.
  assert.deepEqual(owedTotals([card('x'), card('y', { read: read({ conflict: true }) })]), []);
  assert.equal(owedHeadline([]), 'No balance read yet');
  assert.equal(owedNetText([]), null);
});

test('says how many cards are read and as of when, and what the totals leave out', () => {
  const coverage = owedCoverage(CARDS);
  assert.deepEqual(coverage, { total: 7, read: 3, disagree: 1, from: '2026-11-09', to: TODAY });
  assert.equal(owedCoverageText(coverage), '3 of 7 cards read, as of Nov 9 – Nov 22, 2026');
  assert.equal(owedLeftOutText(coverage), 'Not in these totals: 3 cards not read yet and 1 card whose newest reads disagree');
  // One day, every card, one card, none.
  const sameDay = owedCoverage([card('a', { read: balance(1) }), card('b', { read: balance(2) })]);
  assert.equal(owedCoverageText(sameDay), 'All 2 cards read, as of Nov 22, 2026');
  assert.equal(owedLeftOutText(sameDay), null);
  assert.equal(owedCoverageText(owedCoverage([card('a', { read: balance(1) })])), '1 card read, as of Nov 22, 2026');
  assert.equal(owedCoverageText(owedCoverage([card('a'), card('b')])), '0 of 2 cards read');
  assert.equal(owedLeftOutText(owedCoverage([card('a')])), 'Not in these totals: 1 card not read yet');
  assert.equal(owedCoverageText(owedCoverage([])), 'No cards yet');
});

test('groups the cards by issuer and person: the most owed first, then those not read; each card in its place', () => {
  const groups = owedGroups(CARDS);
  assert.deepEqual(groups.map((group) => [group.label, group.read, group.cards.map((item) => item.cardAccountId)]), [
    ['Otherbank · Casey', 1, ['b1', 'b2']],
    // Read balances first, largest first (the credit last); then the cards not read, in the API's order.
    ['Testbank · Alex', 2, ['a1', 'a2', 'a3']],
    ['Quietbank · Alex', 0, ['c1']],
    ['Quietbank · Casey', 0, ['c2']],
  ]);
  const [other, testbank, quietAlex] = groups;
  assert.equal(owedGroupAmount(other), '$3,000.00');
  assert.equal(owedGroupMeta(other), '2 cards: 1 read, 1 with reads that disagree');
  assert.equal(owedGroupAmount(testbank), '$1,200.00');
  assert.equal(owedGroupMeta(testbank), '3 cards: 2 read, 1 not read yet · credits −$500.00');
  assert.equal(owedGroupAmount(quietAlex), 'Not read yet');
  assert.equal(owedGroupMeta(quietAlex), '1 card, not read yet');
  assert.equal(owedGroupMeta(owedGroups([card('a', { read: balance(5) }), card('b', { read: balance(6) })])[0]), '2 cards');
  // A group whose only reads disagree says so, never "not read".
  const [disputed] = owedGroups([card('d', { read: read({ conflict: true }) })]);
  assert.deepEqual([owedGroupAmount(disputed), owedGroupMeta(disputed)], ['Reads disagree', '1 card, reads disagree']);
});

test('a read imported later fills its card, its group and the totals, with nothing else changing', () => {
  const before = CARDS;
  const after = CARDS.map((item) => (item.cardAccountId === 'c1' ? { ...item, read: balance(70_000, { asOfDate: '2026-11-21' }) } : item));
  assert.equal(owedCardAmount(before.find((item) => item.cardAccountId === 'c1')!), 'Not read yet');
  assert.equal(owedCardAmount(after.find((item) => item.cardAccountId === 'c1')!), '$700.00');
  assert.equal(owedHeadline(owedTotals(after)), '$4,900.00 owed now');
  assert.equal(owedCoverageText(owedCoverage(after)), '4 of 7 cards read, as of Nov 9 – Nov 22, 2026');
  const quiet = owedGroups(after).find((group) => group.key === 'quietbank|alex')!;
  assert.deepEqual([owedGroupAmount(quiet), owedGroupMeta(quiet)], ['$700.00', '1 card']);
});

test('each card says its balance, or why there is none, and what else was read of it', () => {
  assert.equal(owedCardAmount(card('a')), 'Not read yet');
  assert.equal(owedCardAmount(card('a', { read: read({ conflict: true }) })), 'Reads disagree');
  assert.equal(owedCardAmount(card('a', { read: balance(-1_234) })), '−$12.34');
  assert.deepEqual(owedCardDetails(card('a'), TODAY), []);
  // A statement with its close, what is left of it, the due date and minimum, and as of when, from where.
  assert.deepEqual(owedCardDetails(card('a', { read: balance(34_567, {
    statementBalanceMinor: 20_000, statementClosingDate: '2026-10-11', remainingStatementMinor: 15_000, paymentDueDate: '2026-12-09',
    minimumDueMinor: 2_500,
  }) }), TODAY), [
    'Statement of Oct 11, 2026: $200.00, $150.00 still to pay',
    'Due Dec 9, 2026, minimum $25.00',
    'As of Nov 22, 2026, from the issuer',
  ]);
  // The last statement without its date; paid; only what is left of it.
  assert.equal(owedCardDetails(card('a', { read: balance(1, { statementBalanceMinor: 41_215 }) }), TODAY)[0], 'Last statement $412.15');
  assert.equal(owedCardDetails(card('a', { read: balance(1, { statementBalanceMinor: 900, remainingStatementMinor: 0 }) }), TODAY)[0],
    'Last statement $9.00, paid');
  assert.equal(owedCardDetails(card('a', { read: balance(1, { remainingStatementMinor: 654_321 }) }), TODAY)[0],
    '$6,543.21 of the last statement still to pay');
  assert.equal(owedCardDetails(card('a', { read: balance(1, { remainingStatementMinor: -10 }) }), TODAY)[0], 'Last statement paid');
  // A disagreement says how it ends.
  assert.deepEqual(owedCardDetails(card('a', { read: read({ conflict: true }) }), TODAY), [
    'Its newest reads disagree on the balance; the next read settles it', 'As of Nov 22, 2026, from the issuer',
  ]);
});

test('a read more than a week old says how old it is; each source says where the read came from', () => {
  assert.equal(owedAsOfText(balance(1, { asOfDate: '2026-11-15' }), TODAY), 'As of Nov 15, 2026, from the issuer');
  assert.equal(owedAsOfText(balance(1, { asOfDate: '2026-11-09' }), TODAY), 'As of Nov 9, 2026 (13 days ago), from the issuer');
  assert.equal(owedAsOfText(balance(1, { sourceKind: 'statement-pdf', asOfDate: '2026-11-11' }), TODAY), 'As of Nov 11, 2026 (11 days ago), from a statement');
  assert.equal(owedAsOfText(balance(1, { sourceKind: 'owner-entry' }), TODAY), 'As of Nov 22, 2026, entered by hand');
  assert.equal(owedAsOfText(balance(1, { sourceKind: 'issuer-dashboard-dom' }), TODAY), 'As of Nov 22, 2026, from the issuer');
});

test('names a card the page doesn\'t know by its issuer, nickname and ending, and says the notes plainly', () => {
  assert.equal(owedCardFallbackName(card('a', { issuer: 'testbank', nickname: 'Everyday', last4: '0001', last5: '50001' })), 'Testbank Everyday ··50001');
  assert.equal(owedCardFallbackName(card('a', { issuer: 'capitalone', last4: '0002' })), 'Capital One ··0002');
  assert.equal(owedCardFallbackName(card('a', { last4: null })), 'Testbank');
  assert.equal(owedHeldText(0), null);
  assert.equal(owedHeldText(1), '1 stored read is not shown: no single card matched, or held for another reason');
  assert.equal(owedHeldText(2), '2 stored reads are not shown: no single card matched, or held for another reason');
  assert.match(OWED_NOT_INSTALLED, /every card shows as not read/);
});
