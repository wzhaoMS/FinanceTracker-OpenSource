import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardOpeningMonthView } from '@finance-tracker/shared';

import {
  CONFIRM_ALL_NOTE,
  OPENINGS_INTRO,
  assertionText,
  changedText,
  confirmAllLabel,
  confirmAllShown,
  earliestFirstKnown,
  evidenceText,
  firstSeenLater,
  flaggedNote,
  laterCardText,
  openedNote,
  openedText,
  openingMonthProblem,
  openingRows,
  prefillText,
  shownMonth,
  statusText,
} from './openingsText';
import { trendMonthSentence } from '../overview/overviewText';

// Synthetic cards, dates and months only.
const TODAY = '2026-10-22';
function card(id: string, patch: Partial<CardOpeningMonthView> = {}): CardOpeningMonthView {
  return {
    cardAccountId: id, firstRowDate: '2024-03-12', firstCoverageDate: '2024-03-10', firstKnownDate: '2024-03-10', prefillMonth: '2024-03',
    openingMonth: null, confirmedAt: null, status: null, history: [], ...patch,
  };
}

test('a card shows what the owner typed, else its month in force, else the month of the first day Holdr has', () => {
  assert.equal(shownMonth(card('a')), '2024-03');
  assert.equal(shownMonth(card('a'), '2023-11'), '2023-11');
  assert.equal(shownMonth(card('a'), ''), '');
  assert.equal(shownMonth(card('a', { openingMonth: '2024-01', status: 'applied' })), '2024-01');
  assert.equal(shownMonth(card('a', { openingMonth: '2024-01', status: 'no-data' })), '2024-01');
  // A month the card's evidence contradicts is not used: the screen offers the month of the first day Holdr has instead.
  assert.equal(shownMonth(card('a', { openingMonth: '2024-05', status: 'contradicted' })), '2024-03');
  assert.equal(shownMonth(card('a', { firstRowDate: null, firstCoverageDate: null, firstKnownDate: null, prefillMonth: null })), '');
});

test('refuses a month the API refuses: later than the first day Holdr has for the card, a row or declared coverage', () => {
  const first = card('a');
  assert.equal(openingMonthProblem(first, '2024-03', TODAY), null);
  assert.equal(openingMonthProblem(first, '2019-01', TODAY), null);
  assert.equal(openingMonthProblem(first, '2024-04', TODAY), 'Holdr has it from Mar 10, 2024: choose March 2024 or earlier');
  // Known from June 15 by its declared coverage, though its first transaction is in September: neither July nor September.
  const declared = card('d', { firstRowDate: '2026-09-20', firstCoverageDate: '2026-06-15', firstKnownDate: '2026-06-15', prefillMonth: '2026-06' });
  for (const month of ['2026-07', '2026-09']) {
    assert.equal(openingMonthProblem(declared, month, TODAY), 'Holdr has it from Jun 15, 2026: choose June 2026 or earlier', month);
  }
  assert.equal(openingMonthProblem(declared, '2026-06', TODAY), null);
  assert.equal(openingMonthProblem(declared, '2026-01', TODAY), null);
  assert.equal(openingMonthProblem(first, '2026-11', TODAY), 'Choose this month or an earlier one');
  assert.equal(openingMonthProblem(card('b', { firstRowDate: null, firstCoverageDate: null, firstKnownDate: null }), '2026-10', TODAY), null);
  for (const month of ['', '2024-3', '2024-13', '1899-12', '2100-01', '2024-03-01', 'March']) {
    assert.equal(openingMonthProblem(first, month, TODAY), 'Choose a month', month);
  }
});

test('confirms all shown: each card whose month would change, and nothing while a month shown is wrong', () => {
  const cards = [
    card('new'),
    card('same', { openingMonth: '2024-03', confirmedAt: '2026-10-01T09:00:00.000Z', status: 'applied' }),
    card('moved', { openingMonth: '2024-03', confirmedAt: '2026-10-01T09:00:00.000Z', status: 'applied' }),
    card('contradicted', { openingMonth: '2024-05', confirmedAt: '2026-10-01T09:00:00.000Z', status: 'contradicted' }),
    card('empty', { firstRowDate: null, firstCoverageDate: null, firstKnownDate: null, prefillMonth: null }),
  ];
  const rows = openingRows(cards, { moved: '2024-02' }, TODAY);
  assert.deepEqual(rows.map((row) => [row.card.cardAccountId, row.month, row.problem, row.changes]), [
    ['new', '2024-03', null, true],
    ['same', '2024-03', null, false],
    ['moved', '2024-02', null, true],
    ['contradicted', '2024-03', null, true],
    ['empty', '', null, false],
  ]);
  const earliest = earliestFirstKnown(cards);
  const all = confirmAllShown(rows, earliest);
  assert.deepEqual(all, { blocked: false, flagged: 0, cards: [
    { cardAccountId: 'new', openingMonth: '2024-03' }, { cardAccountId: 'moved', openingMonth: '2024-02' },
    { cardAccountId: 'contradicted', openingMonth: '2024-03' },
  ] });
  assert.equal(confirmAllLabel(all), 'Confirm all shown (3)');
  assert.equal(flaggedNote(all.flagged), null);
  // One wrong month blocks the batch: nothing is sent until it is fixed.
  const wrong = confirmAllShown(openingRows(cards, { moved: '2024-02', empty: '2026-12' }, TODAY), earliest);
  assert.deepEqual(wrong, { blocked: true, flagged: 0, cards: [] });
  assert.equal(confirmAllLabel(wrong), 'Confirm all shown');
  // A month typed for a card without data is sent; clearing what was typed sends nothing for it.
  assert.deepEqual(confirmAllShown(openingRows([cards[4]], { empty: '2025-01' }, TODAY), earliest).cards, [{ cardAccountId: 'empty', openingMonth: '2025-01' }]);
  assert.deepEqual(confirmAllShown(openingRows([cards[4]], { empty: '' }, TODAY), earliest), { blocked: false, flagged: 0, cards: [] });
  assert.equal(confirmAllLabel(confirmAllShown(openingRows([cards[1]], {}, TODAY), earliest)), 'Every month shown is confirmed');
});

test('confirms all shown except each card first seen after the earliest one: that takes its own Confirm', () => {
  // The earliest card is first seen on May 2, 2023, and is not shown (another person's): every card in the answer counts.
  const day = (id: string, firstKnownDate: string, patch: Partial<CardOpeningMonthView> = {}) =>
    card(id, { firstRowDate: firstKnownDate, firstCoverageDate: null, firstKnownDate, prefillMonth: firstKnownDate.slice(0, 7), ...patch });
  const hidden = day('hidden', '2023-05-02');
  const first = day('first', '2023-05-02');
  const later = day('later', '2024-08-15');
  const latest = day('latest', '2026-10-05');
  const confirmed = day('confirmed', '2025-01-09', { openingMonth: '2025-01', confirmedAt: '2026-10-01T12:00:00.000Z', status: 'applied' });
  const empty = card('empty', { firstRowDate: null, firstCoverageDate: null, firstKnownDate: null, prefillMonth: null });
  const earliest = earliestFirstKnown([hidden, first, later, latest, confirmed, empty]);
  assert.equal(earliest, '2023-05-02');

  // Sent: the card first seen on the earliest day, and one without data given a month. Left out, though their months
  // would change: the two flagged cards, even with a month the owner typed. A month already in force is not sent.
  const rows = openingRows([first, later, latest, confirmed, empty], { latest: '2026-01', empty: '2025-06' }, TODAY);
  const all = confirmAllShown(rows, earliest);
  assert.deepEqual(all, { blocked: false, flagged: 2, cards: [
    { cardAccountId: 'first', openingMonth: '2023-05' }, { cardAccountId: 'empty', openingMonth: '2025-06' },
  ] });
  assert.equal(confirmAllLabel(all), 'Confirm all shown except flagged (2)');
  assert.equal(flaggedNote(all.flagged), '2 flagged cards are left out: each needs its own Confirm.');
  assert.deepEqual(rows.map((row) => laterCardText(row.card, earliest) !== null), [false, true, true, true, false]);

  // Every card shown flagged: the button confirms nothing, and says so. The earliest is the card not shown; over the
  // cards shown alone, the first of them would not be flagged.
  const flaggedOnly = confirmAllShown(openingRows([later, latest], {}, TODAY), earliest);
  assert.deepEqual(flaggedOnly, { blocked: false, flagged: 2, cards: [] });
  assert.equal(confirmAllLabel(flaggedOnly), 'Nothing to confirm at once: each card left is flagged');
  assert.equal(confirmAllShown(openingRows([later, latest], {}, TODAY), earliestFirstKnown([later, latest])).cards.length, 1);
  const one = confirmAllShown(openingRows([later], {}, TODAY), earliest);
  assert.deepEqual(one, { blocked: false, flagged: 1, cards: [] });
  assert.equal(flaggedNote(one.flagged), '1 flagged card is left out: it needs its own Confirm.');
  // A flagged card already confirmed is not left out of anything: nothing would change.
  const done = confirmAllShown(openingRows([{ ...later, openingMonth: '2024-08', confirmedAt: '2026-10-01T12:00:00.000Z', status: 'applied' }], {}, TODAY), earliest);
  assert.deepEqual(done, { blocked: false, flagged: 0, cards: [] });
  assert.equal(confirmAllLabel(done), 'Every month shown is confirmed');
  // A wrong month anywhere still blocks the batch first.
  const blocked = confirmAllShown(openingRows([first, later], { later: '2024-09' }, TODAY), earliest);
  assert.deepEqual([blocked.blocked, blocked.cards, confirmAllLabel(blocked)], [true, [], 'Confirm all shown']);

  // Exactly the line's flag decides. Over first known days, months in force, typed months and earliest days, a card
  // whose month would change is sent if and only if its line has no flag (`laterCardText`), and every other is counted.
  const days = [null, '2023-05-02', '2024-08-15', '2026-10-05'] as const;
  const cards = days.flatMap((firstKnownDate, index) => {
    const base = card(`c${index}`, { firstRowDate: firstKnownDate, firstCoverageDate: null, firstKnownDate, prefillMonth: firstKnownDate?.slice(0, 7) ?? null });
    const at = '2026-10-01T12:00:00.000Z';
    return firstKnownDate === null
      ? [base, { ...base, cardAccountId: `c${index}-confirmed`, openingMonth: '2024-01', confirmedAt: at, status: 'no-data' as const }]
      : [base, { ...base, cardAccountId: `c${index}-applied`, openingMonth: '2022-01', confirmedAt: at, status: 'applied' as const },
        { ...base, cardAccountId: `c${index}-contradicted`, openingMonth: '2026-10', confirmedAt: at, status: 'contradicted' as const }];
  });
  let checked = 0;
  for (const earliestDay of [null, ...days.slice(1)]) {
    for (const typed of [{}, Object.fromEntries(cards.map((item) => [item.cardAccountId, '2021-12']))]) {
      const shown = openingRows(cards, typed, TODAY);
      const batch = confirmAllShown(shown, earliestDay);
      assert.equal(batch.blocked, false);
      const sent = new Set(batch.cards.map((item) => item.cardAccountId));
      for (const row of shown) {
        const flag = laterCardText(row.card, earliestDay) !== null;
        assert.equal(flag, firstSeenLater(row.card, earliestDay));
        assert.equal(sent.has(row.card.cardAccountId), row.changes && !flag, `${row.card.cardAccountId} ${earliestDay} ${row.month}`);
        checked += 1;
      }
      assert.equal(batch.flagged, shown.filter((row) => row.changes && laterCardText(row.card, earliestDay) !== null).length);
      assert.equal(batch.cards.length + batch.flagged, shown.filter((row) => row.changes).length);
    }
  }
  assert.equal(checked, 4 * 2 * cards.length);
});

test('a line still showing its prefill says plainly that it may be only where Holdr\'s history of the card begins', () => {
  const later = card('later', { firstRowDate: '2024-08-15', firstCoverageDate: null, firstKnownDate: '2024-08-15', prefillMonth: '2024-08' });
  const [prefilled] = openingRows([later], {}, TODAY);
  const said = 'August 2024 is where Holdr\'s history of this card begins, which may not be the month it was opened';
  assert.equal(prefillText(prefilled), said);
  // The same when the owner typed that month, or when a month its evidence contradicts gave way to it.
  assert.equal(prefillText(openingRows([later], { later: '2024-08' }, TODAY)[0]), said);
  const at = '2026-10-01T12:00:00.000Z';
  assert.equal(prefillText(openingRows([{ ...later, openingMonth: '2024-10', confirmedAt: at, status: 'contradicted' }], {}, TODAY)[0]), said);
  // Not once the owner chose another month, while a month is in force (even with the prefill typed), or without data.
  const applied: CardOpeningMonthView = { ...later, openingMonth: '2024-08', confirmedAt: at, status: 'applied' };
  const empty = card('empty', { firstRowDate: null, firstCoverageDate: null, firstKnownDate: null, prefillMonth: null });
  for (const row of [
    openingRows([later], { later: '2024-06' }, TODAY)[0],
    openingRows([applied], {}, TODAY)[0],
    openingRows([{ ...applied, openingMonth: '2024-02' }], { later: '2024-08' }, TODAY)[0],
    openingRows([empty], {}, TODAY)[0],
    openingRows([empty], { empty: '2025-01' }, TODAY)[0],
  ]) {
    assert.equal(prefillText(row), null, `${row.card.cardAccountId} ${row.card.openingMonth} ${row.month}`);
  }
});

test('says what Holdr has of each card and where its month stands', () => {
  assert.equal(evidenceText(card('a')), 'Holdr has it from Mar 10, 2024 (first transaction Mar 12, 2024)');
  assert.equal(evidenceText(card('a', { firstCoverageDate: null, firstKnownDate: '2024-03-12' })), 'Holdr has it from Mar 12, 2024');
  assert.equal(evidenceText(card('a', { firstRowDate: null, firstCoverageDate: null, firstKnownDate: null, prefillMonth: null })), 'Nothing stored for it yet');
  assert.equal(statusText(card('a')), 'Not confirmed: shown from the first day Holdr has');
  assert.equal(statusText(card('a', { firstRowDate: null, firstCoverageDate: null, firstKnownDate: null, prefillMonth: null })), 'Not confirmed');
  // Noon UTC is the same calendar day in every zone from UTC-11 to UTC+11.
  const at = '2026-10-01T12:00:00.000Z';
  assert.equal(statusText(card('a', { openingMonth: '2024-03', confirmedAt: at, status: 'applied' })), 'Confirmed March 2024 on Oct 1, 2026');
  assert.equal(statusText(card('a', { openingMonth: '2024-03', confirmedAt: at, status: 'no-data' })), 'Confirmed March 2024 on Oct 1, 2026; used once Holdr has data for it');
  assert.equal(statusText(card('a', { openingMonth: '2024-05', confirmedAt: at, status: 'contradicted' })),
    'May 2024 was confirmed, but Holdr has it from Mar 10, 2024: not used until you confirm again');
  assert.deepEqual([0, 1, 4].map(changedText), [
    'Nothing changed: those months were already confirmed', 'Confirmed 1 card\'s opening month', 'Confirmed 4 cards\' opening months',
  ]);
});

test('says what each confirmation asserts before the click, and flags a card first seen after the earliest one', () => {
  // October 5 is its first known day: confirming October says it had no spending before then.
  const october = card('oct', { firstRowDate: '2026-10-07', firstCoverageDate: '2026-10-05', firstKnownDate: '2026-10-05', prefillMonth: '2026-10' });
  const [shown] = openingRows([october], {}, TODAY);
  assert.equal(assertionText(shown), 'Confirming October 2026 says this card had no spending before Oct 5, 2026');
  // An earlier month: counted from its 1st, and the months before its first day in Holdr stay partial.
  const [earlier] = openingRows([october], { oct: '2026-07' }, TODAY);
  assert.equal(assertionText(earlier), 'Confirming July 2026 says this card had no spending before Jul 1, 2026; '
    + 'the months before Oct 5, 2026, its first day in Holdr, stay marked as possibly missing spending');
  // Nothing to assert when confirming changes nothing, the month is refused, or Holdr has no data for the card.
  const [same] = openingRows([{ ...october, openingMonth: '2026-10', confirmedAt: '2026-10-21T12:00:00.000Z', status: 'applied' }], {}, TODAY);
  const [later] = openingRows([october], { oct: '2026-11' }, TODAY);
  const [empty] = openingRows([card('none', { firstRowDate: null, firstCoverageDate: null, firstKnownDate: null, prefillMonth: null })], { none: '2026-01' }, TODAY);
  assert.deepEqual([same, later, empty].map(assertionText), [null, null, null]);
  assert.equal(empty.changes, true);

  // The earliest first known day over every card account in the answer, not only those shown.
  const all = [october, card('old', { firstKnownDate: '2023-05-02' }), card('none', { firstKnownDate: null })];
  assert.equal(earliestFirstKnown(all), '2023-05-02');
  assert.equal(earliestFirstKnown([card('none', { firstKnownDate: null })]), null);
  assert.equal(laterCardText(october, '2023-05-02'), 'First seen after your earliest card (May 2, 2023): confirm only if it was opened then');
  assert.equal(laterCardText(card('old', { firstKnownDate: '2023-05-02' }), '2023-05-02'), null);
  assert.equal(laterCardText(card('none', { firstKnownDate: null }), '2023-05-02'), null);
  assert.equal(laterCardText(october, null), null);
  assert.match(CONFIRM_ALL_NOTE, /no spending before the day its line names/);
  const words = [assertionText(shown)!, assertionText(earlier)!, laterCardText(october, '2023-05-02')!, CONFIRM_ALL_NOTE, flaggedNote(1)!,
    flaggedNote(3)!, prefillText(shown)!, confirmAllLabel({ cards: [], blocked: false, flagged: 2 }),
    confirmAllLabel({ cards: [{ cardAccountId: 'a', openingMonth: '2026-10' }], blocked: false, flagged: 1 })];
  for (const text of words) {
    assert.doesNotMatch(text, /\b(?:will|always|never)\b|%/i, text);
  }
});

test('says exactly what the owner confirms, with no promise', () => {
  assert.match(OPENINGS_INTRO, /month each card was opened \(its first statement\)/);
  assert.match(OPENINGS_INTRO, /stops expecting a card before that month/);
  assert.match(OPENINGS_INTRO, /counts it from the first day Holdr has for it/);
  assert.match(OPENINGS_INTRO, /includes a card opened this month/);
  assert.doesNotMatch(OPENINGS_INTRO, /\b(?:will|always|never)\b|%/i);
});

test('a window complete only because a card opened in it says so: "includes a card opened this month"', () => {
  assert.equal(openedText(1), 'includes a card opened this month');
  assert.equal(openedText(2), 'includes 2 cards opened this month');
  assert.equal(openedText(1, 'period'), 'includes a card opened in this period');
  const complete = { complete: true, openedCardIds: ['card-a'] };
  assert.equal(openedNote(complete), 'Includes a card opened this month');
  assert.equal(openedNote(complete, { subject: 'August 2024' }), 'August 2024 includes a card opened this month');
  assert.equal(openedNote({ ...complete, openedCardIds: ['card-a', 'card-b'] }, { scope: 'period' }), 'Includes 2 cards opened in this period');
  // Nothing to say for a window that is not complete (it is marked partial), or one no card opened in.
  for (const coverage of [{ complete: false, openedCardIds: ['card-a'] }, { complete: true }, { complete: true, openedCardIds: [] }]) {
    assert.equal(openedNote(coverage), null, JSON.stringify(coverage));
  }
  // The month's own words in the chart: said there too, and nothing changes for a month no card opened in.
  const month = { month: '2024-08', spendingMinor: 4_200, recurringMinor: 0, oneOffMinor: 0, everydayMinor: 4_200,
    coverage: { complete: true, inProgress: false, cardsWithData: 1, cardsExpected: 2, cardsCovered: 2, cardsStartingLater: 0 } };
  const plain = trendMonthSentence(month, 'USD');
  assert.equal(plain, '$42.00 in August 2024: recurring $0.00, large one-offs $0.00, other spending $42.00; data from 1 of 2 cards; '
    + 'every card\'s dates recorded (2 cards)');
  assert.equal(trendMonthSentence({ ...month, coverage: { ...month.coverage, openedCardIds: ['card-a'] } }, 'USD'),
    `${plain}; includes a card opened this month`);
  assert.equal(trendMonthSentence({ ...month, coverage: { ...month.coverage, complete: false, cardsCovered: 1, openedCardIds: ['card-a'] } }, 'USD'),
    trendMonthSentence({ ...month, coverage: { ...month.coverage, complete: false, cardsCovered: 1 } }, 'USD'));
});
