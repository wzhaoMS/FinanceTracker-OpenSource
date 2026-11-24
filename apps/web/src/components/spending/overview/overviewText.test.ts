import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareCardSpending, type CardSpendingComparison } from '@finance-tracker/shared';
import { addMonths as addLedgerMonths, daysIn, seededRandom, syntheticSpendingLedger } from '@finance-tracker/shared/spending-fixtures';

import { formatMinor, merchantDisplayName, spendingPeriodRange, SPENDING_PERIODS } from '../spendingFormat';
import {
  changeText,
  comparisonSentence,
  coverageGapSentences,
  driverSentence,
  insightLintProblems,
  missingHistoryCards,
  missingHistoryLabel,
  monthStateText,
  monthStatesLine,
  oneOffsSentence,
  otherMerchantsText,
  overviewPeriod,
  remainderSentence,
  signedMoney,
  trendMonthSentence,
  windowReasons,
  windowShortNote,
  type SentenceWindow,
} from './overviewText';

// Synthetic figures and ledgers only.

/**
 * A window with data from `cardsWithData` cards: complete unless `known` is false (one expected card without recorded
 * dates), `later` cards in view start after it, or it is `inProgress`.
 */
const window = (
  spendingMinor: number,
  cardsWithData: number,
  options: { count?: number; known?: boolean; later?: number; inProgress?: boolean; to?: string } = {},
): SentenceWindow => {
  const cardsExpected = Math.max(1, cardsWithData);
  return {
    to: options.to ?? '2026-09-30',
    spendingMinor,
    count: options.count ?? (spendingMinor === 0 ? 0 : 3),
    coverage: {
      cardsWithData, cardsExpected, cardsCovered: options.known === false ? cardsExpected - 1 : cardsExpected,
      cardsStartingLater: options.later ?? 0, inProgress: options.inProgress ?? false,
    },
  };
};
const names = { currency: 'USD', periodName: 'October so far', baselineName: 'September at this point' };
const usd = (minor: number) => formatMinor(minor, 'USD');

test('two complete windows are compared in one sentence with its amount, in plain words', () => {
  const sentence = (text: string, tone: 'less' | 'more' | 'same') => ({ text, beside: text, tone, notes: [], bothKnown: true });
  assert.deepEqual(comparisonSentence(window(500_000, 4), window(620_300, 4), names), sentence('$1,203.00 less than September at this point', 'less'));
  assert.deepEqual(comparisonSentence(window(845_000, 4), window(600_000, 4), names), sentence('$2,450.00 more than September at this point', 'more'));
  assert.deepEqual(comparisonSentence(window(5_000, 2), window(5_000, 2), names), sentence('The same as September at this point: $0.00 difference', 'same'));
});

test('a window still going is never compared: both figures side by side, the period noted as still going', () => {
  // Coverage declared through today, the same days of each month: still not compared, as recent charges may not have posted.
  for (const [now, before] of [[1_000, 10_000], [10_000, 1_000], [5_000, 5_000]]) {
    const sentence = comparisonSentence(window(now, 1, { to: '2026-10-22', inProgress: true }), window(before, 1, { to: '2026-09-22' }), names);
    assert.deepEqual(sentence, {
      text: `October so far: ${usd(now)}; September at this point: ${usd(before)}`,
      beside: `September at this point: ${usd(before)}`,
      tone: 'none',
      notes: [{ about: 'current', text: 'October so far may be incomplete (still going through Oct 22, and recent charges may not have posted yet)' }],
      bothKnown: false,
    });
  }
});

test('a partly recorded window is never compared, either way: a missing refund can lower it as a missing charge can raise it', () => {
  const august = { currency: 'USD', periodName: 'September 2026', baselineName: 'August' };
  // August fully recorded ($100), September only in part ($200): not "at least $100 more", as a refund may be missing.
  assert.deepEqual(comparisonSentence(window(20_000, 1, { known: false }), window(10_000, 1), august), {
    text: 'September 2026: $200.00; August: $100.00',
    beside: 'August: $100.00',
    tone: 'none',
    notes: [{ about: 'current', text: 'September 2026 may be incomplete (1 of 1 card has no recorded dates for all of it)' }],
    bothKnown: false,
  });
  // The other way round: the note is on August.
  const reversed = comparisonSentence(window(10_000, 1), window(20_000, 1, { known: false }), august);
  assert.deepEqual([reversed.tone, reversed.bothKnown, reversed.notes],
    ['none', false, [{ about: 'baseline', text: 'August may be incomplete (1 of 1 card has no recorded dates for all of it)' }]]);
  // A card in view with no data that early, and both reasons at once.
  assert.deepEqual(comparisonSentence(window(1_000, 1, { later: 2 }), window(10_000, 1), august).notes,
    [{ about: 'current', text: 'September 2026 may be incomplete (2 cards in view have no data that early)' }]);
  assert.deepEqual(comparisonSentence(window(1_000, 1, { later: 1, known: false }), window(10_000, 1), august).notes, [{
    about: 'current', text: 'September 2026 may be incomplete (1 card in view has no data that early; 1 of 1 card has no recorded dates for all of it)',
  }]);
  // Before the card in view first appears: nothing recorded, and not compared.
  const early: SentenceWindow = {
    to: '2026-08-31', spendingMinor: 0, count: 0, coverage: { cardsWithData: 0, cardsExpected: 0, cardsCovered: 0, cardsStartingLater: 1, inProgress: false },
  };
  assert.deepEqual(comparisonSentence(window(5_000, 1), early, august), {
    text: 'September 2026: $50.00; August: $0.00',
    beside: 'August: $0.00',
    tone: 'none',
    notes: [
      { about: 'baseline', text: 'August may be incomplete (1 card in view has no data that early)' },
      { about: 'both', text: 'August has data from 0 cards; September 2026 from 1' },
    ],
    bothKnown: false,
  });
});

test('windows with data from different numbers of cards are not compared, and a note says so', () => {
  const fewer = comparisonSentence(window(300_000, 2), window(900_000, 5), names);
  assert.deepEqual([fewer.tone, fewer.text, fewer.notes], ['none', 'October so far: $3,000.00; September at this point: $9,000.00',
    [{ about: 'both', text: 'October so far has data from 2 cards; September at this point from 5' }]]);
  assert.deepEqual(comparisonSentence(window(900_000, 5), window(300_000, 2), names).notes,
    [{ about: 'both', text: 'September at this point has data from 2 cards; October so far from 5' }]);
});

test('over every coverage of both windows, a comparison is made only when both are complete, and never bounded', () => {
  type Coverage = SentenceWindow['coverage'];
  const complete = (coverage: Coverage) => !coverage.inProgress && coverage.cardsExpected > 0
    && coverage.cardsCovered === coverage.cardsExpected && coverage.cardsStartingLater === 0;
  const states: Coverage[] = [];
  for (let cardsExpected = 0; cardsExpected <= 3; cardsExpected += 1) {
    for (let cardsCovered = 0; cardsCovered <= cardsExpected; cardsCovered += 1) {
      for (let cardsWithData = 0; cardsWithData <= cardsExpected; cardsWithData += 1) {
        for (const cardsStartingLater of [0, 1]) {
          for (const inProgress of [false, true]) states.push({ cardsWithData, cardsExpected, cardsCovered, cardsStartingLater, inProgress });
        }
      }
    }
  }
  // Amounts lower, equal and higher, a net refund among them: every one for windows that can be compared, one in turn otherwise.
  const amounts = [[0, 0, 0, 0], [-500, 1, 5_000, 2], [5_000, 2, -500, 1], [5_000, 2, 5_000, 2]] as const;
  const figures = new Map<number, string>();
  const figure = (minor: number) => figures.get(minor) ?? figures.set(minor, usd(minor)).get(minor)!;
  const options = { currency: 'USD', periodName: 'September 2026', baselineName: 'August' };
  const check = (ok: boolean, why: () => string) => { if (!ok) assert.fail(why()); };
  const linted = new Set<string>();
  let compared = 0;
  let apart = 0;
  let turn = 0;
  for (const now of states) {
    for (const before of states) {
      const both = complete(now) && complete(before) && now.cardsWithData === before.cardsWithData;
      for (const [nowMinor, nowCount, beforeMinor, beforeCount] of both ? amounts : [amounts[turn++ % amounts.length]]) {
        const current: SentenceWindow = { to: '2026-09-20', spendingMinor: nowMinor, count: nowCount, coverage: now };
        const baseline: SentenceWindow = { to: '2026-08-20', spendingMinor: beforeMinor, count: beforeCount, coverage: before };
        const sentence = comparisonSentence(current, baseline, options);
        const context = () => JSON.stringify({ current, baseline, sentence });
        const delta = nowMinor - beforeMinor;
        check(sentence.bothKnown === both && !/at least/i.test(sentence.text), context);
        if (both) {
          check(sentence.tone === (delta < 0 ? 'less' : delta > 0 ? 'more' : 'same') && sentence.notes.length === 0 && sentence.beside === sentence.text, context);
          compared += 1;
        } else {
          // Both figures side by side, no word of more or less, and a note on each window that may be incomplete.
          check(sentence.tone === 'none' && sentence.text === `September 2026: ${figure(nowMinor)}; August: ${figure(beforeMinor)}`
            && sentence.beside === `August: ${figure(beforeMinor)}` && !/\b(?:more|less|same)\b/.test(sentence.text), context);
          check(sentence.notes.some((note) => note.about === 'current') === !complete(now)
            && sentence.notes.some((note) => note.about === 'baseline') === !complete(before)
            && sentence.notes.some((note) => note.about === 'both') === (now.cardsWithData !== before.cardsWithData), context);
          apart += 1;
        }
        for (const text of [sentence.text, sentence.beside, ...sentence.notes.map((note) => note.text)]) {
          if (linted.has(text)) continue;
          assert.deepEqual(insightLintProblems(text), [], text);
          linted.add(text);
        }
      }
    }
  }
  assert.ok(compared > 80 && apart > 14_000, `${compared} compared, ${apart} apart`);
});

test('periods compare with the month before and the same month last year, to this day while the month is going', () => {
  const today = '2026-10-22';
  const current = overviewPeriod('month', spendingPeriodRange('month', '2026-10', today), '2026-10', today);
  assert.deepEqual([current.from, current.to, current.name, current.inProgress, current.toMonth], ['2026-10-01', today, 'October so far', true, '2026-10']);
  assert.deepEqual(current.comparisons.map((item) => [item.baselineFrom, item.baselineTo, item.baselineName]), [
    ['2026-09-01', '2026-09-22', 'September at this point'],
    ['2025-10-01', '2025-10-22', 'October 2025 at this point'],
  ]);
  const march = overviewPeriod('month', spendingPeriodRange('month', '2026-03', '2026-03-31'), '2026-03', '2026-03-31');
  assert.deepEqual(march.comparisons[0].baselineTo, '2026-02-28');
  const past = overviewPeriod('month', spendingPeriodRange('month', '2026-01', today), '2026-01', today);
  assert.deepEqual([past.from, past.to, past.name, past.inProgress], ['2026-01-01', '2026-01-31', 'January 2026', false]);
  assert.deepEqual(past.comparisons.map((item) => [item.baselineFrom, item.baselineTo, item.baselineName]), [
    ['2025-12-01', '2025-12-31', 'December 2025'],
    ['2025-01-01', '2025-01-31', 'January 2025'],
  ]);
  for (const { id } of SPENDING_PERIODS) {
    for (const day of ['2026-10-22', '2026-03-31', '2024-02-29', '2026-01-01']) {
      const period = overviewPeriod(id, spendingPeriodRange(id, day.slice(0, 7), day), day.slice(0, 7), day);
      assert.ok(period.comparisons.length >= 1, `${id} ${day}`);
      for (const comparison of period.comparisons) {
        assert.ok(comparison.baselineFrom <= comparison.baselineTo, `${id} ${day} ${comparison.key}`);
        assert.ok(comparison.baselineTo < comparison.from, `${id} ${day} ${comparison.key}: the baseline ends before`);
        assert.deepEqual([comparison.from, comparison.to], [period.from, period.to]);
        assert.deepEqual(insightLintProblems(`$1 more than ${comparison.baselineName}`), [], comparison.baselineName);
      }
      assert.deepEqual(insightLintProblems(`$1 in ${period.name}`), [], period.name);
    }
  }
});

test('the lint catches what an insight must not be', () => {
  assert.deepEqual(insightLintProblems('Spending went up'), ['no number', 'no time window']);
  assert.deepEqual(insightLintProblems('You will spend $400 in November'), ['says will, always or never']);
  assert.deepEqual(insightLintProblems('Groceries were 40% higher in September'), ['has a percentage']);
  assert.deepEqual(insightLintProblems('Projected $3,000 in November'), ['a forecast not called an estimate']);
  assert.deepEqual(insightLintProblems('An estimate: projected $3,000 in November'), []);
  assert.deepEqual(insightLintProblems('$4 less than the 90 days before'), []);
});

/** Every sentence the overview can say about one comparison. */
function sentencesOf(comparison: CardSpendingComparison, options: { periodName: string; baselineName: string }): string[] {
  const { currency } = comparison;
  // Every coverage case: equal and unequal cards with data, each side known or not, cards that start later, still going.
  const coverage = (cardsWithData: number, known: boolean, later = 0, inProgress = false) => ({
    coverage: {
      cardsWithData, cardsExpected: Math.max(1, cardsWithData), cardsCovered: known ? Math.max(1, cardsWithData) : 0, cardsStartingLater: later, inProgress,
    },
  });
  const sentences: string[] = [];
  for (const [now, before, knownNow, knownBefore, later, going] of [
    [3, 3, true, true, 0, false], [2, 4, true, true, 0, false], [4, 2, true, true, 0, false], [3, 3, false, true, 0, false],
    [3, 3, true, false, 0, false], [3, 3, false, false, 0, false], [1, 3, false, true, 2, false], [3, 3, true, true, 0, true], [2, 3, false, true, 1, true],
  ] as const) {
    const sentence = comparisonSentence({ ...comparison.current, ...coverage(now, knownNow, later, going) },
      { ...comparison.baseline, ...coverage(before, knownBefore) }, { currency, ...options });
    sentences.push(sentence.text, sentence.beside, ...sentence.notes.map((note) => note.text));
  }
  sentences.push(oneOffsSentence(comparison.current.oneOffMinor, comparison.baseline.oneOffMinor, { currency, ...options }));
  for (const driver of comparison.drivers) {
    sentences.push(driverSentence(driver, { currency, baselineName: options.baselineName, merchantName: merchantDisplayName }));
  }
  sentences.push(remainderSentence(comparison.remainder.deltaMinor, comparison.remainder.categories, { currency, baselineName: options.baselineName }));
  sentences.push(changeText(comparison.deltaMinor, currency, options.baselineName));
  return sentences;
}

test('every sentence the overview can produce passes the insight lint, on generated ledgers', () => {
  let checked = 0;
  for (let seed = 1; seed <= 12; seed += 1) {
    const ledger = syntheticSpendingLedger({ seed, months: 16 });
    for (const offset of [1, 2, 13]) {
      const month = addLedgerMonths(ledger.lastMonth, -1);
      const baselineMonth = addLedgerMonths(ledger.lastMonth, -1 - offset);
      const current = { from: `${month}-01`, to: `${month}-${String(daysIn(month)).padStart(2, '0')}` };
      const baseline = { from: `${baselineMonth}-01`, to: `${baselineMonth}-${String(daysIn(baselineMonth)).padStart(2, '0')}` };
      const comparison = compareCardSpending(ledger.rows, { currency: 'USD', through: current.to, current, baseline });
      for (const options of [
        { periodName: 'October so far', baselineName: 'September at this point' },
        { periodName: 'the last 90 days', baselineName: 'the 90 days before' },
        { periodName: '2026 to date', baselineName: '2025 to the same date' },
      ]) {
        for (const sentence of sentencesOf(comparison, options)) {
          assert.deepEqual(insightLintProblems(sentence), [], sentence);
          checked += 1;
        }
      }
    }
  }
  // Months of the chart, complete, partial, starting later and still going.
  const next = seededRandom(3);
  for (let index = 0; index < 200; index += 1) {
    const cardsExpected = Math.floor(next() * 20);
    const sentence = trendMonthSentence({
      month: `2026-${String(1 + (index % 12)).padStart(2, '0')}`, spendingMinor: Math.floor(next() * 9_000_000), recurringMinor: Math.floor(next() * 90_000),
      oneOffMinor: Math.floor(next() * 5_000_000), everydayMinor: Math.floor(next() * 2_000_000),
      coverage: { complete: next() < 0.3, inProgress: next() < 0.1, cardsWithData: Math.floor(next() * (cardsExpected + 1)), cardsExpected,
        cardsCovered: Math.floor(next() * (cardsExpected + 1)), cardsStartingLater: next() < 0.4 ? Math.floor(next() * 6) : 0 },
    }, 'USD');
    assert.deepEqual(insightLintProblems(sentence), [], sentence);
    checked += 1;
  }
  assert.ok(checked > 600, `${checked} sentences`);
});

test('a month says why it may be missing spending, and never that it is lower', () => {
  const month = { month: '2025-11', spendingMinor: 120_000, recurringMinor: 1_599, oneOffMinor: 0, everydayMinor: 118_401 };
  const coverage = { complete: false, inProgress: false, cardsWithData: 3, cardsExpected: 3, cardsCovered: 3, cardsStartingLater: 6 };
  assert.equal(trendMonthSentence({ ...month, coverage }, 'USD'),
    '$1,200.00 in November 2025 (incomplete): recurring $15.99, large one-offs $0.00, other spending $1,184.01; data from 3 of 3 cards; '
    + 'partial: 6 cards in view have no data this early, so this month may be missing spending; it is not lower spending');
  assert.match(trendMonthSentence({ ...month, coverage: { ...coverage, cardsCovered: 1, cardsStartingLater: 1 } }, 'USD'),
    /partial: 1 of 3 cards with recorded dates; 1 card in view has no data this early, so this month may be missing spending; it is not lower spending$/);
  assert.match(trendMonthSentence({ ...month, coverage: { ...coverage, complete: true, cardsStartingLater: 0 } }, 'USD'),
    /every card's dates recorded \(3 cards\)$/);
  assert.match(trendMonthSentence({ ...month, coverage: { ...coverage, inProgress: true } }, 'USD'),
    /; still going, and recent charges may not have posted yet, so it is not lower spending$/);
  // Its amount and month first, its state after them (contract C-4); a complete month has none.
  assert.match(trendMonthSentence({ ...month, coverage: { ...coverage, inProgress: true } }, 'USD'), /^\$1,200\.00 in November 2025 \(month in progress\): recurring /);
  assert.match(trendMonthSentence({ ...month, coverage: { ...coverage, complete: true, cardsStartingLater: 0 } }, 'USD'), /^\$1,200\.00 in November 2025: recurring /);
});

test('the months say their state in words, on each month or in one line, and how many cards miss history', () => {
  const going = { complete: false, inProgress: true, cardsExpected: 2, cardsStartingLater: 0 };
  const partial = { complete: false, inProgress: false, cardsExpected: 2, cardsStartingLater: 0 };
  const later = { complete: false, inProgress: false, cardsExpected: 0, cardsStartingLater: 1 };
  const complete = { complete: true, inProgress: false, cardsExpected: 2, cardsStartingLater: 0 };
  const none = { complete: false, inProgress: false, cardsExpected: 0, cardsStartingLater: 0 };
  assert.deepEqual([going, partial, later, complete, none].map(monthStateText), ['Month in progress', 'Incomplete', 'Incomplete', null, null]);
  const months = [
    ['2025-10', later], ['2025-11', partial], ['2025-12', partial], ['2026-01', complete], ['2026-02', partial], ['2026-03', none],
    ['2026-04', complete], ['2026-05', going],
  ].map(([month, coverage]) => ({ month: month as string, coverage: coverage as typeof complete }));
  const short = (month: string) => ({ '2025-10': 'Oct', '2025-11': 'Nov', '2025-12': 'Dec', '2026-02': 'Feb', '2026-05': 'May' } as Record<string, string>)[month] ?? month;
  assert.equal(monthStatesLine(months, short), 'Incomplete: Oct–Dec and Feb · Month in progress: May');
  assert.equal(monthStatesLine(months.filter((item) => item.coverage === complete), short), null);
  // A card both behind and first seen later is one card.
  const gaps = {
    behind: [{ cardAccountId: 'card-a' }, { cardAccountId: 'card-b' }],
    startingLater: [{ cardAccountId: 'card-b' }, { cardAccountId: 'card-c' }],
  };
  assert.equal(missingHistoryCards(gaps), 3);
  assert.equal(missingHistoryLabel(missingHistoryCards(gaps)), 'Missing history (3 cards)');
  assert.equal(missingHistoryLabel(1), 'Missing history (1 card)');
});

test('the hatched months say which cards keep them from counting, by name, and what would let them count', () => {
  const names = new Map([['card-a', 'Sample Bank ··0001 · Alex'], ['card-b', 'Fourth Card ··0002 · Casey'], ['card-c', 'Sample Rewards ··0003 · Alex']]);
  const cardName = (id: string) => names.get(id) ?? 'a card no longer listed';
  const sentences = coverageGapSentences({
    behind: [{ cardAccountId: 'card-b', coveredThrough: null }, { cardAccountId: 'card-c', coveredThrough: null },
      { cardAccountId: 'card-a', coveredThrough: '2026-07-31' }],
    startingLater: [{ cardAccountId: 'card-c', firstKnown: '2026-02-14' }, { cardAccountId: 'card-b', firstKnown: '2026-05-03' }],
  }, { cardName, firstMonth: '2025-11' });
  assert.deepEqual(sentences, [
    'No statements imported for Fourth Card ··0002 · Casey and Sample Rewards ··0003 · Alex',
    'No statements imported after Jul 31, 2026 for Sample Bank ··0001 · Alex',
    '2 cards in view were first seen after November 2025, the latest on May 3, 2026, so earlier months can\'t count',
    'To count those months, import recent statements, or mark cards no longer used as closed',
  ]);
  // One card first seen later and none behind: no fix to offer for importing.
  assert.deepEqual(coverageGapSentences({ behind: [], startingLater: [{ cardAccountId: 'card-a', firstKnown: '2026-06-01' }] }, { cardName, firstMonth: '2025-11' }),
    ['1 card in view was first seen after November 2025, on Jun 1, 2026, so earlier months can\'t count']);
  assert.deepEqual(coverageGapSentences({ behind: [], startingLater: [] }, { cardName, firstMonth: '2025-11' }), []);
  for (const sentence of sentences) assert.doesNotMatch(sentence, /\b(?:will|always|never)\b|%/);
});

test('signed amounts and changes read as statements', () => {
  assert.equal(signedMoney(42_000, 'USD'), '+$420.00');
  assert.equal(signedMoney(-8_000, 'USD'), '−$80.00');
  assert.equal(signedMoney(0, 'USD'), '$0.00');
  assert.equal(changeText(-8_000, 'USD', 'September'), '$80.00 less than September');
  assert.equal(remainderSentence(1_500, 1, { currency: 'USD', baselineName: 'September' }), 'Everything else: $15.00 more than September, across 1 other category');
});

test('the row holding the merchants not named says how many', () => {
  assert.equal(otherMerchantsText(1), '1 other merchant');
  assert.equal(otherMerchantsText(92), '92 other merchants');
  assert.equal(otherMerchantsText(1_204), '1,204 other merchants');
});

test('a window that may be incomplete is said in a line, with why apart', () => {
  // Said once in a line; why is folded under it, each reason in its own words.
  const going = window(1_000, 1, { to: '2026-10-22', inProgress: true, known: false });
  assert.equal(windowShortNote(going, 'October so far'), 'October so far may be incomplete');
  assert.deepEqual(windowReasons(going), [
    'still going through Oct 22, and recent charges may not have posted yet', '1 of 1 card has no recorded dates for all of it',
  ]);
  assert.equal(windowShortNote(window(1_000, 2, { later: 1 }), 'september 2025 at this point'), 'September 2025 at this point may be incomplete');
  assert.deepEqual(windowReasons(window(1_000, 2, { later: 1 })), ['1 card in view has no data that early']);
  // Complete: nothing to say.
  assert.equal(windowShortNote(window(1_000, 2), 'August'), null);
  assert.deepEqual(windowReasons(window(1_000, 2)), []);
});
