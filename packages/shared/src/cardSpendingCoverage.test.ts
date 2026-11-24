import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cardSpendingCoverageByMonth,
  cardSpendingCoverageForRange,
  cardSpendingCoverageGaps,
  type CardCoverageCard,
  type CardCoverageEvidence,
  type CardCoverageRow,
  type CardSpendingCoverageMonthsInput,
} from './cardSpendingCoverage.js';

// Synthetic cards, dates and coverage only.
const card = (id: string, status: 'active' | 'closed' = 'active'): CardCoverageCard => ({ id, status });
const row = (cardAccountId: string, transactionDate: string, status: CardCoverageRow['status'] = 'posted'): CardCoverageRow =>
  ({ cardAccountId, transactionDate, status });
const covered = (cardAccountId: string, ...ranges: Array<[string, string]>): CardCoverageEvidence =>
  ({ cardAccountId, ranges: ranges.map(([start, end]) => ({ start, end })) });

function input(overrides: Partial<CardSpendingCoverageMonthsInput> = {}): CardSpendingCoverageMonthsInput {
  return { cards: [], coverage: [], rows: [], today: '2026-10-22', ...overrides };
}

const monthOf = (months: ReturnType<typeof cardSpendingCoverageByMonth>, month: string) => {
  const found = months.find((item) => item.month === month);
  assert.ok(found, `no entry for ${month}`);
  return found;
};

describe('card coverage by month', () => {
  it('is complete for a past month every expected card is covered for, day by day', () => {
    const months = cardSpendingCoverageByMonth(input({
      cards: [card('card-a'), card('card-b')],
      rows: [row('card-a', '2026-08-03'), row('card-a', '2026-08-20'), row('card-b', '2026-08-11')],
      coverage: [covered('card-a', ['2026-08-01', '2026-09-30']), covered('card-b', ['2026-07-15', '2026-08-31'])],
      from: '2026-08',
      to: '2026-09',
    }));
    assert.deepEqual(months, [
      { month: '2026-08', complete: true, cardsWithData: 2, cardsExpected: 2, cardsCovered: 2, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [] },
      // card-b's coverage ends in August: September is unknown for it, though card-a is covered and has no rows there.
      { month: '2026-09', complete: false, cardsWithData: 0, cardsExpected: 2, cardsCovered: 1, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: ['card-b'] },
    ]);
  });

  it('never assumes coverage: rows alone, or coverage that starts or ends inside the month, leave it incomplete', () => {
    const months = cardSpendingCoverageByMonth(input({
      cards: [card('card-a'), card('card-b'), card('card-c')],
      rows: [row('card-a', '2026-05-02'), row('card-b', '2026-05-09'), row('card-c', '2026-05-30')],
      coverage: [covered('card-b', ['2026-05-02', '2026-05-31']), covered('card-c', ['2026-05-01', '2026-05-30'])],
      from: '2026-05',
      to: '2026-05',
    }));
    assert.deepEqual(months[0], {
      month: '2026-05', complete: false, cardsWithData: 3, cardsExpected: 3, cardsCovered: 0, cardsStartingLater: 0, inProgress: false,
      uncoveredCardIds: ['card-a', 'card-b', 'card-c'],
    });
  });

  it('joins overlapping and adjacent coverage ranges, from any source, before judging a month', () => {
    const months = cardSpendingCoverageByMonth(input({
      cards: [card('card-a')],
      rows: [row('card-a', '2026-03-10')],
      coverage: [
        covered('card-a', ['2026-03-16', '2026-03-31']),
        covered('card-a', ['2026-02-20', '2026-03-05'], ['2026-03-06', '2026-03-15']),
      ],
      from: '2026-03',
      to: '2026-03',
    }));
    assert.equal(months[0].complete, true);
    const gap = cardSpendingCoverageByMonth(input({
      cards: [card('card-a')],
      rows: [row('card-a', '2026-03-10')],
      coverage: [covered('card-a', ['2026-02-20', '2026-03-05'], ['2026-03-07', '2026-03-31'])],
      from: '2026-03',
      to: '2026-03',
    }));
    assert.deepEqual([gap[0].complete, gap[0].uncoveredCardIds], [false, ['card-a']]);
  });

  it('counts a covered month without rows as complete: read, and nothing there', () => {
    const [month] = cardSpendingCoverageByMonth(input({
      cards: [card('card-a')],
      rows: [row('card-a', '2026-01-04'), row('card-a', '2026-03-04')],
      coverage: [covered('card-a', ['2026-01-01', '2026-03-31'])],
      from: '2026-02',
      to: '2026-02',
    }));
    assert.deepEqual(month, { month: '2026-02', complete: true, cardsWithData: 0, cardsExpected: 1, cardsCovered: 1, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [] });
  });

  it('never calls a month complete before a card in view first appears: the record may not reach back that far', () => {
    const months = cardSpendingCoverageByMonth(input({
      cards: [card('card-old'), card('card-new'), card('card-imported')],
      rows: [row('card-old', '2026-01-10'), row('card-new', '2026-04-02'), row('card-imported', '2026-06-01')],
      coverage: [covered('card-old', ['2026-01-01', '2026-06-30']), covered('card-imported', ['2026-02-01', '2026-06-30'])],
      from: '2026-01',
      to: '2026-06',
    }));
    assert.deepEqual(months.map((item) => [item.month, item.cardsExpected, item.cardsCovered, item.cardsStartingLater, item.complete]), [
      // card-old is covered all along, yet January to March are not complete: two cards first appear later, and nothing
      // tells a card opened later from history that was never imported.
      ['2026-01', 1, 1, 2, false],
      // card-imported's coverage starts on the 1st of February: it is known from then, read and empty.
      ['2026-02', 2, 2, 1, false],
      ['2026-03', 2, 2, 1, false],
      // card-new's first row is in April and it has no coverage: April on is unknown for it.
      ['2026-04', 3, 2, 0, false],
      ['2026-05', 3, 2, 0, false],
      ['2026-06', 3, 2, 0, false],
    ]);
    assert.deepEqual(monthOf(months, '2026-04').uncoveredCardIds, ['card-new']);
    // Once every card in view is known and covered, the months count.
    const later = cardSpendingCoverageByMonth(input({
      cards: [card('card-old'), card('card-imported')],
      rows: [row('card-old', '2026-01-10'), row('card-imported', '2026-06-01')],
      coverage: [covered('card-old', ['2026-01-01', '2026-06-30']), covered('card-imported', ['2026-02-01', '2026-06-30'])],
      from: '2026-01',
      to: '2026-03',
    }));
    assert.deepEqual(later.map((item) => [item.month, item.cardsStartingLater, item.complete]), [['2026-01', 1, false], ['2026-02', 0, true], ['2026-03', 0, true]]);
    // A card with neither rows nor coverage is no evidence of anything, so it starts nothing later.
    const empty = cardSpendingCoverageByMonth(input({
      cards: [card('card-old'), card('card-empty')],
      rows: [row('card-old', '2026-01-10')],
      coverage: [covered('card-old', ['2026-01-01', '2026-02-28'])],
      from: '2026-01',
      to: '2026-01',
    }));
    assert.deepEqual([empty[0].cardsStartingLater, empty[0].complete], [0, true]);
  });

  it('stops expecting a closed card after its last row or coverage; an active one is expected through today', () => {
    const months = cardSpendingCoverageByMonth(input({
      cards: [card('card-closed', 'closed'), card('card-quiet')],
      rows: [row('card-closed', '2026-02-14'), row('card-closed', '2026-03-03'), row('card-quiet', '2026-02-02')],
      coverage: [
        covered('card-closed', ['2026-02-01', '2026-04-30']),
        covered('card-quiet', ['2026-02-01', '2026-04-30']),
      ],
      from: '2026-02',
      to: '2026-06',
    }));
    assert.deepEqual(months.map((item) => [item.month, item.cardsExpected, item.cardsCovered, item.complete]), [
      ['2026-02', 2, 2, true],
      ['2026-03', 2, 2, true],
      // The closed card's coverage runs to April's end: expected, and covered, through April.
      ['2026-04', 2, 2, true],
      // The active card has no rows since February but is still a card: May is unknown without its coverage.
      ['2026-05', 1, 0, false],
      ['2026-06', 1, 0, false],
    ]);
  });

  it('never calls a month complete before it is over, nor one still to come, covered or not', () => {
    const cards = [card('card-a')];
    const rows = [row('card-a', '2026-09-02'), row('card-a', '2026-10-05')];
    const coverage = [covered('card-a', ['2026-09-01', '2026-12-31'])];
    const months = cardSpendingCoverageByMonth(input({ cards, rows, coverage, today: '2026-10-22', to: '2026-11' }));
    assert.deepEqual(months.map((item) => [item.month, item.inProgress, item.complete]), [
      ['2026-09', false, true], ['2026-10', true, false], ['2026-11', true, false],
    ]);
    // A month's last day is not over until the next day.
    const lastDay = cardSpendingCoverageByMonth(input({ cards, rows, coverage, today: '2026-09-30', from: '2026-09', to: '2026-09' }));
    assert.deepEqual([lastDay[0].inProgress, lastDay[0].complete], [true, false]);
    const nextDay = cardSpendingCoverageByMonth(input({ cards, rows, coverage, today: '2026-10-01', from: '2026-09', to: '2026-09' }));
    assert.deepEqual([nextDay[0].inProgress, nextDay[0].complete], [false, true]);
  });

  it('reads only the cards in view: other cards\' rows and coverage, and removed rows, change nothing', () => {
    const base = input({
      cards: [card('card-a')],
      rows: [row('card-a', '2026-07-09')],
      coverage: [covered('card-a', ['2026-07-01', '2026-07-31'])],
      from: '2026-07',
      to: '2026-07',
    });
    const before = cardSpendingCoverageByMonth(base);
    const after = cardSpendingCoverageByMonth({
      ...base,
      rows: [...base.rows, row('card-b', '2026-07-03'), row('card-a', '2026-06-30', 'removed'), row('card-a', 'not-a-date')],
      coverage: [...base.coverage, covered('card-b', ['2026-06-01', '2026-06-30'])],
    });
    assert.deepEqual(after, before);
    assert.deepEqual(before[0], { month: '2026-07', complete: true, cardsWithData: 1, cardsExpected: 1, cardsCovered: 1, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [] });
    // A pending row is data; a card with neither rows nor coverage is never expected.
    const pending = cardSpendingCoverageByMonth(input({
      cards: [card('card-a'), card('card-empty')],
      rows: [row('card-a', '2026-07-09', 'pending')],
      from: '2026-07',
      to: '2026-07',
    }));
    assert.deepEqual([pending[0].cardsWithData, pending[0].cardsExpected, pending[0].complete], [1, 1, false]);
  });

  it('lists every month from the first row to today by default, and nothing without rows or coverage', () => {
    const months = cardSpendingCoverageByMonth(input({
      cards: [card('card-a')],
      rows: [row('card-a', '2026-07-31'), row('card-a', '2026-09-01')],
      today: '2026-10-02',
    }));
    assert.deepEqual(months.map((item) => item.month), ['2026-07', '2026-08', '2026-09', '2026-10']);
    assert.deepEqual(cardSpendingCoverageByMonth(input({ cards: [card('card-a')] })), []);
    assert.deepEqual(cardSpendingCoverageByMonth(input({ cards: [card('card-a')], from: '2026-09', to: '2026-08' })), []);
    // With coverage only, from its first month.
    const coverageOnly = cardSpendingCoverageByMonth(input({ cards: [card('card-a')], coverage: [covered('card-a', ['2026-08-01', '2026-08-31'])], today: '2026-09-15' }));
    assert.deepEqual(coverageOnly.map((item) => [item.month, item.complete]), [['2026-08', true], ['2026-09', false]]);
  });

  it('refuses malformed bounds and days', () => {
    assert.throws(() => cardSpendingCoverageByMonth(input({ today: '2026-13-01' })), RangeError);
    assert.throws(() => cardSpendingCoverageByMonth(input({ from: '2026-1' })), RangeError);
    assert.throws(() => cardSpendingCoverageForRange(input(), { from: '2026-09-10', to: '2026-09-01' }), RangeError);
    assert.throws(() => cardSpendingCoverageForRange(input(), { from: '2026-02-30', to: '2026-03-01' }), RangeError);
  });
});

describe('card coverage of a range of days', () => {
  const cards = [card('card-a'), card('card-b')];
  const rows = [row('card-a', '2026-09-03'), row('card-b', '2026-10-12')];
  const coverage = [covered('card-a', ['2026-08-01', '2026-10-31']), covered('card-b', ['2026-10-01', '2026-10-21'])];

  it('judges the range\'s own days by the month rules', () => {
    // card-b first appears on October 1: before it, the record may not reach back for it, so September is not complete.
    assert.deepEqual(cardSpendingCoverageForRange(input({ cards, rows, coverage }), { from: '2026-09-01', to: '2026-09-21' }), {
      from: '2026-09-01', to: '2026-09-21', complete: false, cardsWithData: 1, cardsExpected: 1, cardsCovered: 1, cardsStartingLater: 1,
      inProgress: false, uncoveredCardIds: [],
    });
    assert.deepEqual(cardSpendingCoverageForRange(input({ cards, rows, coverage }), { from: '2026-10-01', to: '2026-10-21' }), {
      from: '2026-10-01', to: '2026-10-21', complete: true, cardsWithData: 1, cardsExpected: 2, cardsCovered: 2, cardsStartingLater: 0,
      inProgress: false, uncoveredCardIds: [],
    });
    // A range reaching today is in progress, and a day past card-b's coverage is unknown.
    assert.deepEqual(cardSpendingCoverageForRange(input({ cards, rows, coverage }), { from: '2026-10-01', to: '2026-10-22' }), {
      from: '2026-10-01', to: '2026-10-22', complete: false, cardsWithData: 1, cardsExpected: 2, cardsCovered: 1, cardsStartingLater: 0,
      inProgress: true, uncoveredCardIds: ['card-b'],
    });
  });

  it('agrees with the month rules over a whole month', () => {
    const months = cardSpendingCoverageByMonth(input({ cards, rows, coverage, from: '2026-08', to: '2026-10' }));
    for (const item of months) {
      const last = new Date(Date.UTC(Number(item.month.slice(0, 4)), Number(item.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
      const { from: _from, to: _to, ...range } = cardSpendingCoverageForRange(input({ cards, rows, coverage }), { from: `${item.month}-01`, to: last });
      const { month: _month, ...rest } = item;
      assert.deepEqual(range, rest, item.month);
    }
  });
});

describe('what keeps a view\'s months from being complete', () => {
  const view = (overrides: Partial<CardSpendingCoverageMonthsInput> = {}) => input({
    cards: [card('a'), card('b'), card('c'), card('d', 'closed'), card('e')],
    rows: [row('a', '2026-03-05'), row('b', '2026-01-10'), row('c', '2026-02-02'), row('d', '2026-01-04'), row('e', '2026-10-02')],
    coverage: [covered('a', ['2026-01-01', '2026-04-30'], ['2026-05-01', '2026-07-31']), covered('c', ['2026-01-01', '2026-09-30']),
      covered('d', ['2026-01-01', '2026-03-31'])],
    ...overrides,
  });

  it('names the open cards whose coverage stops before the last month that can be complete, and the cards first seen later', () => {
    // September is the last month over on Oct 22: a stops in July and b has nothing recorded; c reaches it; d is closed.
    assert.deepEqual(cardSpendingCoverageGaps(view()), {
      lastCompletableMonth: '2026-09',
      behind: [{ cardAccountId: 'b', coveredThrough: null }, { cardAccountId: 'a', coveredThrough: '2026-07-31' }],
      startingLater: [{ cardAccountId: 'e', firstKnown: '2026-10-02' }],
    });
    // Through May only: a reaches May's end; e is not expected yet, and still starts later.
    assert.deepEqual(cardSpendingCoverageGaps(view({ from: '2026-01', to: '2026-05' })), {
      lastCompletableMonth: '2026-05',
      behind: [{ cardAccountId: 'b', coveredThrough: null }],
      startingLater: [{ cardAccountId: 'e', firstKnown: '2026-10-02' }],
    });
    // October alone: none of its days is over yet, so nothing can be complete and no card is behind.
    assert.deepEqual(cardSpendingCoverageGaps(view({ from: '2026-10', to: '2026-10' })).lastCompletableMonth, null);
    assert.deepEqual(cardSpendingCoverageGaps(view({ from: '2026-10', to: '2026-10' })).behind, []);
    assert.deepEqual(cardSpendingCoverageGaps(input()), { lastCompletableMonth: null, behind: [], startingLater: [] });
    assert.throws(() => cardSpendingCoverageGaps(view({ from: '2026-13' })), RangeError);
  });

  it('agrees with the months: their first month counts the cards that start later, and the cards behind leave the last one incomplete', () => {
    const months = cardSpendingCoverageByMonth(view());
    const gaps = cardSpendingCoverageGaps(view());
    assert.equal(months[0].cardsStartingLater, gaps.startingLater.length);
    const september = months.find((month) => month.month === '2026-09')!;
    assert.equal(september.complete, false);
    for (const item of gaps.behind) assert.ok(september.uncoveredCardIds.includes(item.cardAccountId), item.cardAccountId);
  });
});

describe('card coverage on generated ledgers', () => {
  /** A small deterministic generator (mulberry32): the same ledgers on every run. */
  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const day = (index: number) => new Date(Date.UTC(2025, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
  const monthEnd = (month: string) =>
    `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;

  it('says which cards keep the months from counting, by the month rules\' own figures', () => {
    let behind = 0;
    let later = 0;
    for (let seed = 201; seed <= 320; seed += 1) {
      const next = random(seed);
      const cards = Array.from({ length: 1 + Math.floor(next() * 5) }, (_, index) => card(`card-${index}`, next() < 0.25 ? 'closed' : 'active'));
      const rows: CardCoverageRow[] = [];
      const coverage: CardCoverageEvidence[] = [];
      for (const item of cards) {
        const start = Math.floor(next() * 500);
        for (let index = 0; index < Math.floor(next() * 20); index += 1) {
          rows.push(row(item.id, day(start + Math.floor(next() * 300)), next() < 0.1 ? 'removed' : 'posted'));
        }
        for (let index = 0; index < Math.floor(next() * 3); index += 1) {
          const from = start + Math.floor(next() * 200);
          coverage.push(covered(item.id, [day(from), day(from + Math.floor(next() * 250))]));
        }
      }
      const today = day(300 + Math.floor(next() * 400));
      const view = { cards, rows, coverage, today, from: day(Math.floor(next() * 200)).slice(0, 7), to: day(250 + Math.floor(next() * 500)).slice(0, 7) };
      const months = cardSpendingCoverageByMonth(view);
      const gaps = cardSpendingCoverageGaps(view);
      if (months.length === 0) {
        assert.deepEqual(gaps, { lastCompletableMonth: null, behind: [], startingLater: [] });
        continue;
      }
      // As many cards start later as the first month counts, each after it.
      assert.equal(gaps.startingLater.length, months[0].cardsStartingLater, `seed ${seed}`);
      assert.ok(gaps.startingLater.every((item) => item.firstKnown > monthEnd(months[0].month)), `seed ${seed}`);
      later += gaps.startingLater.length;
      // The last month that can be complete is the last one over before today.
      const over = months.filter((month) => !month.inProgress);
      assert.equal(gaps.lastCompletableMonth, over.length > 0 ? over[over.length - 1].month : null, `seed ${seed}`);
      if (gaps.lastCompletableMonth === null) {
        assert.deepEqual(gaps.behind, []);
        continue;
      }
      const month = months.find((item) => item.month === gaps.lastCompletableMonth)!;
      const end = monthEnd(month.month);
      // Independently: open cards there whose recorded coverage stops before its last day.
      const expected = cards.filter((item) => item.status !== 'closed').flatMap((item) => {
        const live = rows.filter((entry) => entry.cardAccountId === item.id && entry.status !== 'removed').map((entry) => entry.transactionDate);
        const ranges = coverage.filter((entry) => entry.cardAccountId === item.id).flatMap((entry) => entry.ranges);
        const first = [...live, ...ranges.map((range) => range.start)].sort()[0];
        if (first === undefined || first > end) return [];
        const ends = ranges.map((range) => range.end).sort();
        const reach = ends.length > 0 ? ends[ends.length - 1] : null;
        return reach === null || reach < end ? [{ cardAccountId: item.id, coveredThrough: reach }] : [];
      });
      assert.deepEqual([...gaps.behind].sort((a, b) => (a.cardAccountId < b.cardAccountId ? -1 : 1)), expected, `seed ${seed}`);
      // Each is one of that month's uncovered cards, so the month is not complete.
      for (const item of gaps.behind) assert.ok(month.uncoveredCardIds.includes(item.cardAccountId), `seed ${seed} ${item.cardAccountId}`);
      if (gaps.behind.length > 0) assert.equal(month.complete, false);
      behind += gaps.behind.length;
    }
    assert.ok(behind >= 20 && later >= 20, `${behind} behind, ${later} later`);
  });

  it('calls a month complete only when every expected card\'s coverage holds each of its days', () => {
    const seen = { complete: 0, incomplete: 0 };
    for (let seed = 1; seed <= 120; seed += 1) {
      const next = random(seed);
      const cardCount = 1 + Math.floor(next() * 5);
      const cards = Array.from({ length: cardCount }, (_, index) => card(`card-${index}`, next() < 0.25 ? 'closed' : 'active'));
      const rows: CardCoverageRow[] = [];
      const coverage: CardCoverageEvidence[] = [];
      for (const item of cards) {
        const start = Math.floor(next() * 400);
        const length = Math.floor(next() * 300);
        for (let index = 0; index < 1 + Math.floor(next() * 25); index += 1) {
          rows.push(row(item.id, day(start + Math.floor(next() * (length + 1))), next() < 0.1 ? 'removed' : next() < 0.2 ? 'pending' : 'posted'));
        }
        for (let index = 0; index < Math.floor(next() * 4); index += 1) {
          const from = start - 40 + Math.floor(next() * (length + 80));
          coverage.push(covered(item.id, [day(Math.max(0, from)), day(Math.max(0, from) + Math.floor(next() * 120))]));
        }
      }
      const today = day(200 + Math.floor(next() * 500));
      const months = cardSpendingCoverageByMonth({ cards, rows, coverage, today });
      for (const month of months) {
        assert.ok(month.cardsWithData <= month.cardsExpected && month.cardsCovered <= month.cardsExpected, `${seed} ${month.month}`);
        assert.equal(month.cardsCovered + month.uncoveredCardIds.length, month.cardsExpected);
        seen[month.complete ? 'complete' : 'incomplete'] += 1;
        if (!month.complete) continue;
        assert.ok(!month.inProgress && month.cardsExpected > 0 && month.cardsCovered === month.cardsExpected && month.cardsStartingLater === 0);
        // Day by day: every card with a row or coverage in or around the month is covered on each of its days.
        const last = new Date(Date.UTC(Number(month.month.slice(0, 4)), Number(month.month.slice(5, 7)), 0)).getUTCDate();
        for (const item of cards) {
          const live = rows.filter((entry) => entry.cardAccountId === item.id && entry.status !== 'removed');
          const ranges = coverage.filter((entry) => entry.cardAccountId === item.id).flatMap((entry) => entry.ranges);
          const known = [...live.map((entry) => entry.transactionDate), ...ranges.map((range) => range.start)].sort();
          const ends = [...live.map((entry) => entry.transactionDate), ...ranges.map((range) => range.end)].sort();
          // No month before any card's first known day is complete.
          if (known.length > 0) assert.ok(known[0] <= `${month.month}-${String(last).padStart(2, '0')}`, `seed ${seed}: ${month.month} before ${item.id} appears`);
          const expected = known.length > 0 && known[0] <= `${month.month}-${String(last).padStart(2, '0')}`
            && (item.status !== 'closed' || ends[ends.length - 1] >= `${month.month}-01`);
          if (!expected) continue;
          for (let date = 1; date <= last; date += 1) {
            const iso = `${month.month}-${String(date).padStart(2, '0')}`;
            assert.ok(ranges.some((range) => range.start <= iso && range.end >= iso), `seed ${seed}: ${item.id} not covered on ${iso}`);
          }
        }
      }
    }
    // The ledgers exercise both answers.
    assert.ok(seen.complete >= 20 && seen.incomplete >= 20, JSON.stringify(seen));
  });

  it('never calls a month complete before any card in view first appears, nor counts such a card as expected', () => {
    let before = 0;
    for (let seed = 101; seed <= 160; seed += 1) {
      const next = random(seed);
      const cards = Array.from({ length: 2 + Math.floor(next() * 4) }, (_, index) => card(`card-${index}`));
      const rows: CardCoverageRow[] = [];
      const coverage: CardCoverageEvidence[] = [];
      const firsts: string[] = [];
      for (const item of cards) {
        const start = Math.floor(next() * 500);
        // Every card read from its first day on, to the end: only its first day can make a month incomplete.
        coverage.push(covered(item.id, [day(start), day(900)]));
        rows.push(row(item.id, day(start + Math.floor(next() * 30))));
        firsts.push(day(start));
      }
      const latest = [...firsts].sort()[firsts.length - 1];
      for (const month of cardSpendingCoverageByMonth({ cards, rows, coverage, today: day(899), from: '2025-01', to: day(860).slice(0, 7) })) {
        const last = new Date(Date.UTC(Number(month.month.slice(0, 4)), Number(month.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
        assert.equal(month.cardsStartingLater, firsts.filter((first) => first > last).length, `seed ${seed} ${month.month}`);
        // Every card (all active, all with data) is expected in the month or starts after it.
        assert.equal(month.cardsExpected + month.cardsStartingLater, cards.length, `seed ${seed} ${month.month}: expected or later`);
        if (last < latest) {
          assert.equal(month.complete, false, `seed ${seed} ${month.month}`);
          before += 1;
        } else {
          // From the month the last card appears in on, a card read from its first day is covered only from the month after.
          const startsInside = firsts.some((first) => first.slice(0, 7) === month.month && first.slice(8) !== '01');
          assert.equal(month.complete, !startsInside, `seed ${seed} ${month.month}`);
        }
      }
    }
    assert.ok(before > 100, `${before} months before a card appears`);
  });
});
