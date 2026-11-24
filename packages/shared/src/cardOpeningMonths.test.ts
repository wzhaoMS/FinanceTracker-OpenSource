import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cardOpeningDay,
  cardOpeningEvidence,
  cardOpeningMonthStatus,
  isCardOpeningMonth,
} from './cardOpeningMonths.js';
import {
  cardSpendingCoverageByMonth,
  cardSpendingCoverageForRange,
  cardSpendingCoverageGaps,
  type CardCoverageCard,
  type CardCoverageEvidence,
  type CardCoverageRow,
  type CardSpendingCoverageInput,
} from './cardSpendingCoverage.js';

// Synthetic cards, dates and coverage only.
const card = (id: string, openingMonth?: string | null, status: 'active' | 'closed' = 'active'): CardCoverageCard =>
  (openingMonth === undefined ? { id, status } : { id, status, openingMonth });
const row = (cardAccountId: string, transactionDate: string, status: CardCoverageRow['status'] = 'posted'): CardCoverageRow =>
  ({ cardAccountId, transactionDate, status });
const covered = (cardAccountId: string, ...ranges: Array<[string, string]>): CardCoverageEvidence =>
  ({ cardAccountId, ranges: ranges.map(([start, end]) => ({ start, end })) });
const lastDayOf = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const summary = (months: ReturnType<typeof cardSpendingCoverageByMonth>) =>
  months.map((item) => [item.month, item.cardsExpected, item.cardsCovered, item.cardsStartingLater, item.complete]);

describe('card opening evidence', () => {
  it('reads each card\'s first stored row and first known coverage, as coverage reads them, and prefills the earlier month', () => {
    const evidence = cardOpeningEvidence({
      cards: [{ id: 'card-a' }, { id: 'card-b' }, { id: 'card-c' }, { id: 'card-a' }],
      rows: [
        row('card-a', '2026-03-12'), row('card-a', '2026-03-09', 'removed'), row('card-a', 'not-a-date'), row('card-a', '2026-02-30'),
        row('card-b', '2026-05-01', 'pending'), row('card-b', '2026-05-20'), row('card-other', '2020-01-01'),
      ],
      coverage: [
        covered('card-a', ['2026-03-20', '2026-04-30'], ['2026-03-10', '2026-03-19']),
        // Backwards: not a range, ignored as coverage ignores it.
        covered('card-a', ['2026-02-10', '2026-02-01']),
        covered('card-other', ['2019-01-01', '2019-12-31']),
      ],
    });
    assert.deepEqual(evidence, [
      { cardAccountId: 'card-a', firstRowDate: '2026-03-12', firstCoverageDate: '2026-03-10', firstKnownDate: '2026-03-10', prefillMonth: '2026-03' },
      { cardAccountId: 'card-b', firstRowDate: '2026-05-01', firstCoverageDate: null, firstKnownDate: '2026-05-01', prefillMonth: '2026-05' },
      { cardAccountId: 'card-c', firstRowDate: null, firstCoverageDate: null, firstKnownDate: null, prefillMonth: null },
    ]);
    // A row before the coverage is the first known day.
    assert.deepEqual(cardOpeningEvidence({ cards: [{ id: 'card-a' }], rows: [row('card-a', '2026-02-27')], coverage: [covered('card-a', ['2026-03-01', '2026-03-31'])] }),
      [{ cardAccountId: 'card-a', firstRowDate: '2026-02-27', firstCoverageDate: '2026-03-01', firstKnownDate: '2026-02-27', prefillMonth: '2026-02' }]);
  });

  it('applies a confirmed month unless the card\'s first known day is before it; a card without data is ignored either way', () => {
    const evidence = { firstRowDate: '2026-04-02', firstKnownDate: '2026-03-28' };
    assert.equal(cardOpeningMonthStatus('2026-03', evidence), 'applied');
    assert.equal(cardOpeningMonthStatus('2020-01', evidence), 'applied');
    // Later than the month of the first known day: evidence already exists earlier, whether a row or declared coverage.
    assert.equal(cardOpeningMonthStatus('2026-04', evidence), 'contradicted');
    assert.equal(cardOpeningMonthStatus('2026-05', evidence), 'contradicted');
    assert.equal(cardOpeningMonthStatus('2026-05', { firstKnownDate: '2026-03-28' }), 'contradicted');
    assert.equal(cardOpeningMonthStatus('2026-05', { firstKnownDate: null }), 'no-data');
    // The day it is expected from: its first known day when that is in the month, else the month's 1st.
    assert.equal(cardOpeningDay('2026-03', evidence), '2026-03-28');
    assert.equal(cardOpeningDay('2026-01', evidence), '2026-01-01');
    assert.equal(cardOpeningDay('2026-04', evidence), null);
    assert.equal(cardOpeningDay('2026-05', { firstKnownDate: null }), null);
    for (const month of ['2026-4', '2026-13', '2026-00', '26-04', '2026-04-01', ' 2026-04', '']) {
      assert.equal(isCardOpeningMonth(month), false, month);
      assert.throws(() => cardOpeningDay(month, evidence), RangeError);
    }
    assert.equal(isCardOpeningMonth(202604), false);
    assert.equal(isCardOpeningMonth('2026-12'), true);
  });
});

describe('card coverage with confirmed opening months', () => {
  // card-old is read from January on; card-new's first row is on April 2, and its import covers April 2 onwards.
  const base = (openingMonth?: string | null): CardSpendingCoverageInput & { from: string; to: string } => ({
    cards: [card('card-old'), card('card-new', openingMonth)],
    rows: [row('card-old', '2026-01-10'), row('card-new', '2026-04-02'), row('card-new', '2026-05-17')],
    coverage: [covered('card-old', ['2026-01-01', '2026-06-30']), covered('card-new', ['2026-04-02', '2026-06-30'])],
    today: '2026-07-15',
    from: '2026-01',
    to: '2026-06',
  });

  it('does not expect a card before its confirmed month, and counts its month from its first known day', () => {
    assert.deepEqual(summary(cardSpendingCoverageByMonth(base())), [
      // Without the owner's month, card-new may simply not have been imported this far back.
      ['2026-01', 1, 1, 1, false], ['2026-02', 1, 1, 1, false], ['2026-03', 1, 1, 1, false],
      // Its record starts on April 2: April's 1st is unknown for it.
      ['2026-04', 2, 1, 0, false],
      ['2026-05', 2, 2, 0, true], ['2026-06', 2, 2, 0, true],
    ]);
    const confirmed = cardSpendingCoverageByMonth(base('2026-04'));
    assert.deepEqual(summary(confirmed), [
      ['2026-01', 1, 1, 0, true], ['2026-02', 1, 1, 0, true], ['2026-03', 1, 1, 0, true],
      // Opened in April, and read from its first known day to April's end: the days before are before the card existed.
      ['2026-04', 2, 2, 0, true],
      ['2026-05', 2, 2, 0, true], ['2026-06', 2, 2, 0, true],
    ]);
    assert.deepEqual(confirmed[3], {
      month: '2026-04', complete: true, cardsWithData: 1, cardsExpected: 2, cardsCovered: 2, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [],
      // Complete only because card-new opened in it, on its first known day: said so.
      openedCardIds: ['card-new'],
    });
    assert.ok(confirmed.filter((month) => month.month !== '2026-04').every((month) => !('openedCardIds' in month)));
    // A card whose record starts on the 1st of its opening month is expected for all of it: nothing to say.
    const first = base('2026-04');
    first.coverage = [covered('card-old', ['2026-01-01', '2026-06-30']), covered('card-new', ['2026-04-01', '2026-06-30'])];
    assert.ok(cardSpendingCoverageByMonth(first).every((month) => !('openedCardIds' in month)));
    assert.equal(cardSpendingCoverageByMonth(first)[3].complete, true);
  });

  it('expects the card, uncovered, from an earlier confirmed month: those months stay partial', () => {
    assert.deepEqual(summary(cardSpendingCoverageByMonth(base('2026-02'))), [
      ['2026-01', 1, 1, 0, true],
      // Opened in February, yet its record starts on April 2: February and March are not known for it.
      ['2026-02', 2, 1, 0, false], ['2026-03', 2, 1, 0, false],
      // In April it existed from the 1st, and its coverage starts on the 2nd.
      ['2026-04', 2, 1, 0, false],
      ['2026-05', 2, 2, 0, true], ['2026-06', 2, 2, 0, true],
    ]);
    assert.deepEqual(cardSpendingCoverageByMonth(base('2026-02'))[1].uncoveredCardIds, ['card-new']);
    // The same for a card known only by its declared coverage: the months between stay partial.
    const unread = cardSpendingCoverageByMonth({ ...base('2026-01'), rows: [row('card-old', '2026-01-10')] });
    assert.deepEqual(summary(unread), [
      ['2026-01', 2, 1, 0, false], ['2026-02', 2, 1, 0, false], ['2026-03', 2, 1, 0, false], ['2026-04', 2, 1, 0, false],
      ['2026-05', 2, 2, 0, true], ['2026-06', 2, 2, 0, true],
    ]);
  });

  it('never applies a month later than the card\'s first known day: the evidence wins, as without a month', () => {
    for (const month of ['2026-05', '2026-06', '2027-01']) {
      assert.deepEqual(cardSpendingCoverageByMonth(base(month)), cardSpendingCoverageByMonth(base()), month);
    }
    // A removed row is no evidence, but declared coverage is: May still does not apply.
    const removed = base('2026-05');
    removed.rows = [row('card-old', '2026-01-10'), row('card-new', '2026-04-02', 'removed'), row('card-new', '2026-05-17')];
    assert.deepEqual(cardSpendingCoverageByMonth(removed), cardSpendingCoverageByMonth({ ...removed, cards: [card('card-old'), card('card-new')] }));
    // Without that earlier evidence (the row removed, coverage from May), May applies, from its 1st.
    removed.coverage = [covered('card-old', ['2026-01-01', '2026-06-30']), covered('card-new', ['2026-05-01', '2026-06-30'])];
    assert.deepEqual(summary(cardSpendingCoverageByMonth(removed)), [
      ['2026-01', 1, 1, 0, true], ['2026-02', 1, 1, 0, true], ['2026-03', 1, 1, 0, true], ['2026-04', 1, 1, 0, true],
      ['2026-05', 2, 2, 0, true], ['2026-06', 2, 2, 0, true],
    ]);
  });

  it('needs the opening month covered from the first known day to its end, in one range', () => {
    const gap = base('2026-04');
    gap.coverage = [covered('card-old', ['2026-01-01', '2026-06-30']), covered('card-new', ['2026-04-02', '2026-04-10'], ['2026-04-12', '2026-06-30'])];
    assert.deepEqual(summary(cardSpendingCoverageByMonth(gap)).slice(3), [['2026-04', 2, 1, 0, false], ['2026-05', 2, 2, 0, true], ['2026-06', 2, 2, 0, true]]);
    // A first row before the coverage starts: the days between are not known.
    const early = base('2026-04');
    early.rows = [...early.rows, row('card-new', '2026-04-01', 'pending')];
    assert.deepEqual(summary(cardSpendingCoverageByMonth(early))[3], ['2026-04', 2, 1, 0, false]);
    // Coverage ending inside a later month leaves that month unknown, as without a month.
    const ends = base('2026-04');
    ends.coverage = [covered('card-old', ['2026-01-01', '2026-06-30']), covered('card-new', ['2026-04-02', '2026-06-29'])];
    assert.deepEqual(summary(cardSpendingCoverageByMonth(ends)).slice(3), [['2026-04', 2, 2, 0, true], ['2026-05', 2, 2, 0, true], ['2026-06', 2, 1, 0, false]]);
  });

  it('refuses the owner\'s later month when declared coverage reaches back before it: as without a month', () => {
    // An import declared from New Year, though the owner says March: the evidence starts in January, so March does not
    // apply and the card is expected from New Year, as without a month.
    const input = {
      cards: [card('card-old'), card('card-new', '2026-03')],
      rows: [row('card-old', '2026-01-10'), row('card-new', '2026-03-15')],
      coverage: [covered('card-old', ['2026-01-01', '2026-04-30']), covered('card-new', ['2026-01-01', '2026-04-30'])],
      today: '2026-07-15',
      from: '2026-01',
      to: '2026-04',
    };
    const months = cardSpendingCoverageByMonth(input);
    assert.deepEqual(months, cardSpendingCoverageByMonth({ ...input, cards: [card('card-old'), card('card-new')] }));
    assert.deepEqual(summary(months), [['2026-01', 2, 2, 0, true], ['2026-02', 2, 2, 0, true], ['2026-03', 2, 2, 0, true], ['2026-04', 2, 2, 0, true]]);
    assert.equal(cardOpeningMonthStatus('2026-03', cardOpeningEvidence(input).find((item) => item.cardAccountId === 'card-new')!), 'contradicted');
  });

  it('keeps a closed card to its last known day, and still ignores a card with neither rows nor coverage', () => {
    const months = cardSpendingCoverageByMonth({
      cards: [card('card-old'), card('card-closed', '2026-02', 'closed'), card('card-empty', '2026-01')],
      rows: [row('card-old', '2026-01-10'), row('card-closed', '2026-02-20')],
      coverage: [covered('card-old', ['2026-01-01', '2026-05-31']), covered('card-closed', ['2026-02-20', '2026-03-31'])],
      today: '2026-07-15',
      from: '2026-01',
      to: '2026-05',
    });
    assert.deepEqual(summary(months), [
      ['2026-01', 1, 1, 0, true], ['2026-02', 2, 2, 0, true], ['2026-03', 2, 2, 0, true], ['2026-04', 1, 1, 0, true], ['2026-05', 1, 1, 0, true],
    ]);
  });

  it('judges a range of days the same way: before the opening day the card neither counts nor starts later', () => {
    const input = base('2026-04');
    const range = (from: string, to: string) => cardSpendingCoverageForRange(input, { from, to });
    assert.deepEqual(range('2026-04-01', '2026-04-01'), {
      from: '2026-04-01', to: '2026-04-01', complete: true, cardsWithData: 0, cardsExpected: 1, cardsCovered: 1, cardsStartingLater: 0,
      inProgress: false, uncoveredCardIds: [],
    });
    assert.deepEqual(range('2026-03-15', '2026-04-15'), {
      from: '2026-03-15', to: '2026-04-15', complete: true, cardsWithData: 1, cardsExpected: 2, cardsCovered: 2, cardsStartingLater: 0,
      inProgress: false, uncoveredCardIds: [], openedCardIds: ['card-new'],
    });
    // Without the owner's month the same windows are not complete.
    assert.equal(cardSpendingCoverageForRange(base(), { from: '2026-04-01', to: '2026-04-01' }).complete, false);
    assert.equal(cardSpendingCoverageForRange(base(), { from: '2026-03-15', to: '2026-04-15' }).complete, false);
    // A window over an earlier confirmed month: needed from the month's 1st.
    assert.deepEqual(cardSpendingCoverageForRange(base('2026-03'), { from: '2026-03-15', to: '2026-04-15' }).uncoveredCardIds, ['card-new']);
  });

  it('is exactly the answer without months while no month is confirmed, and refuses a malformed one', () => {
    const plain = cardSpendingCoverageByMonth({ ...base(), cards: [{ id: 'card-old' }, { id: 'card-new' }] });
    for (const openingMonth of [undefined, null]) {
      assert.equal(JSON.stringify(cardSpendingCoverageByMonth({ ...base(), cards: [{ id: 'card-old', openingMonth }, { id: 'card-new', openingMonth }] })),
        JSON.stringify(plain));
    }
    for (const openingMonth of ['2026-4', '2026-13', '2026-04-01', 202604, '']) {
      assert.throws(() => cardSpendingCoverageByMonth({ ...base(), cards: [card('card-new', openingMonth as string)] }), RangeError);
      assert.throws(() => cardSpendingCoverageForRange({ ...base(), cards: [card('card-new', openingMonth as string)] },
        { from: '2026-04-01', to: '2026-04-30' }), RangeError);
      assert.throws(() => cardSpendingCoverageGaps({ ...base(), cards: [card('card-new', openingMonth as string)] }), RangeError);
    }
  });

  it('says why months are hatched by the same rule: a confirmed card never starts later, and is behind from its month', () => {
    assert.deepEqual(cardSpendingCoverageGaps(base()), {
      lastCompletableMonth: '2026-06', behind: [], startingLater: [{ cardAccountId: 'card-new', firstKnown: '2026-04-02' }],
    });
    assert.deepEqual(cardSpendingCoverageGaps(base('2026-04')), { lastCompletableMonth: '2026-06', behind: [], startingLater: [] });
    // Its record starts after the last month that can be complete: without a month it starts later; with the owner's
    // earlier month it is expected there with no statements, so it is behind.
    const unread = (openingMonth?: string): CardSpendingCoverageInput & { from: string; to: string } => ({
      ...base(), cards: [card('card-old'), card('card-new', openingMonth)], rows: [row('card-old', '2026-01-10'), row('card-new', '2026-08-03')],
      coverage: [covered('card-old', ['2026-01-01', '2026-06-30'])],
    });
    assert.deepEqual(cardSpendingCoverageGaps(unread()), {
      lastCompletableMonth: '2026-06', behind: [], startingLater: [{ cardAccountId: 'card-new', firstKnown: '2026-08-03' }],
    });
    assert.deepEqual(cardSpendingCoverageGaps(unread('2026-02')), {
      lastCompletableMonth: '2026-06', behind: [{ cardAccountId: 'card-new', coveredThrough: null }], startingLater: [],
    });
    // A month its row contradicts does not apply.
    assert.deepEqual(cardSpendingCoverageGaps(unread('2026-09')), cardSpendingCoverageGaps(unread()));
  });
});

describe('card coverage with opening months on generated ledgers', () => {
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
  const shiftMonth = (month: string, by: number) => {
    const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by;
    return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
  };

  /** A household: cards with rows, coverage, a status and maybe an opening month (the prefill, earlier, later or none). */
  function ledger(seed: number) {
    const next = random(seed);
    const ids = Array.from({ length: 1 + Math.floor(next() * 5) }, (_, index) => `card-${index}`);
    const rows: CardCoverageRow[] = [];
    const coverage: CardCoverageEvidence[] = [];
    for (const id of ids) {
      if (next() < 0.08) continue;
      const start = Math.floor(next() * 500);
      const length = Math.floor(next() * 300);
      for (let index = 0; index < Math.floor(next() * 20); index += 1) {
        rows.push(row(id, day(start + Math.floor(next() * (length + 1))), next() < 0.1 ? 'removed' : next() < 0.2 ? 'pending' : 'posted'));
      }
      for (let index = 0; index < Math.floor(next() * 4); index += 1) {
        const from = Math.max(0, start - 40 + Math.floor(next() * (length + 80)));
        coverage.push(covered(id, [day(from), day(from + Math.floor(next() * 160))]));
      }
      // Often an import from the card's first day on, as an export from its first statement reads.
      if (next() < 0.5) coverage.push(covered(id, [day(start), day(start + Math.floor(next() * 700))]));
    }
    const evidence = new Map(cardOpeningEvidence({ cards: ids.map((id) => ({ id })), rows, coverage }).map((item) => [item.cardAccountId, item]));
    const cards = ids.map((id): CardCoverageCard => {
      const prefill = evidence.get(id)!.prefillMonth ?? '2025-06';
      const pick = next();
      const status = next() < 0.2 ? 'closed' : 'active';
      if (pick < 0.2) return { id, status };
      if (pick < 0.3) return { id, status, openingMonth: null };
      if (pick < 0.65) return { id, status, openingMonth: prefill };
      return { id, status, openingMonth: shiftMonth(prefill, Math.floor(next() * 9) - 4) };
    });
    return { cards, rows, coverage, today: day(150 + Math.floor(next() * 600)) };
  }

  /** The rules, day by day and card by card, written apart from the implementation. */
  function oracle(input: ReturnType<typeof ledger>, from: string, to: string) {
    let cardsExpected = 0;
    let cardsWithData = 0;
    let cardsStartingLater = 0;
    const uncoveredCardIds: string[] = [];
    const openedCardIds: string[] = [];
    for (const item of input.cards) {
      const live = input.rows.filter((entry) => entry.cardAccountId === item.id && entry.status !== 'removed').map((entry) => entry.transactionDate).sort();
      const ranges = input.coverage.filter((entry) => entry.cardAccountId === item.id).flatMap((entry) => entry.ranges);
      const starts = [...live, ...ranges.map((range) => range.start)].sort();
      const ends = [...live, ...ranges.map((range) => range.end)].sort();
      if (starts.length === 0) continue;
      const month = item.openingMonth ?? null;
      // The owner's month applies unless the card's first known day (a row or coverage) is before it.
      const applies = month !== null && starts[0] >= `${month}-01`;
      const opening = !applies ? null : starts[0].slice(0, 7) === month ? starts[0] : `${month}-01`;
      if (opening !== null && opening > to) continue;
      if (opening === null && starts[0] > to) {
        cardsStartingLater += 1;
        continue;
      }
      if (item.status === 'closed' && ends[ends.length - 1] < from) continue;
      cardsExpected += 1;
      if (live.some((date) => date >= from && date <= to)) cardsWithData += 1;
      // Expected only from an opening day inside the window: the window's days before it are before the card existed.
      if (opening !== null && opening > from) openedCardIds.push(item.id);
      let known = true;
      for (let date = opening !== null && opening > from ? opening : from; date <= to; date = nextDay(date)) {
        if (!ranges.some((range) => range.start <= date && range.end >= date)) {
          known = false;
          break;
        }
      }
      if (!known) uncoveredCardIds.push(item.id);
    }
    uncoveredCardIds.sort();
    openedCardIds.sort();
    return {
      complete: to < input.today && cardsExpected > 0 && uncoveredCardIds.length === 0 && cardsStartingLater === 0,
      cardsWithData,
      cardsExpected,
      cardsCovered: cardsExpected - uncoveredCardIds.length,
      cardsStartingLater,
      inProgress: to >= input.today,
      uncoveredCardIds,
      ...(openedCardIds.length > 0 ? { openedCardIds } : {}),
    };
  }

  it('agrees with the rules, day by day, for every month and for ranges of days', () => {
    const seen = { complete: 0, incomplete: 0, applied: 0, contradicted: 0, opening: 0, opened: 0 };
    for (let seed = 1; seed <= 150; seed += 1) {
      const input = ledger(seed);
      const evidence = cardOpeningEvidence(input);
      for (const item of input.cards) {
        if (typeof item.openingMonth !== 'string') continue;
        const status = cardOpeningMonthStatus(item.openingMonth, evidence.find((entry) => entry.cardAccountId === item.id)!);
        if (status !== 'no-data') seen[status] += 1;
      }
      for (const month of cardSpendingCoverageByMonth({ ...input, from: '2025-01', to: day(760).slice(0, 7) })) {
        const { month: name, ...known } = month;
        assert.deepEqual(known, oracle(input, `${name}-01`, lastDayOf(name)), `seed ${seed} ${name}`);
        seen[month.complete ? 'complete' : 'incomplete'] += 1;
        // A month complete only because a card opened in it says which.
        if (month.complete && month.openedCardIds) seen.opened += 1;
      }
      const next = random(seed * 7919);
      for (let index = 0; index < 12; index += 1) {
        const from = Math.floor(next() * 740);
        const range = { from: day(from), to: day(from + Math.floor(next() * 70)) };
        const { from: _from, to: _to, ...known } = cardSpendingCoverageForRange(input, range);
        const expected = oracle(input, range.from, range.to);
        assert.deepEqual(known, expected, `seed ${seed} ${range.from}..${range.to}`);
        if (expected.cardsExpected > 0 && input.cards.some((item) => typeof item.openingMonth === 'string')) seen.opening += 1;
      }
    }
    // The ledgers exercise every answer.
    assert.ok(seen.complete >= 50 && seen.incomplete >= 50 && seen.applied >= 50 && seen.contradicted >= 10 && seen.opening >= 100
      && seen.opened >= 5, JSON.stringify(seen));
  });

  it('says which cards keep the months from counting by the same figures, months confirmed or not', () => {
    let behind = 0;
    let later = 0;
    const byCard = (a: { cardAccountId: string }, b: { cardAccountId: string }) => (a.cardAccountId < b.cardAccountId ? -1 : 1);
    for (let seed = 701; seed <= 820; seed += 1) {
      const input = ledger(seed);
      const months = cardSpendingCoverageByMonth(input);
      const gaps = cardSpendingCoverageGaps(input);
      if (months.length === 0) {
        assert.deepEqual(gaps, { lastCompletableMonth: null, behind: [], startingLater: [] });
        continue;
      }
      // As many cards start later as the first month counts: none whose owner's month applies.
      assert.equal(gaps.startingLater.length, months[0].cardsStartingLater, `seed ${seed}`);
      later += gaps.startingLater.length;
      if (gaps.lastCompletableMonth === null) {
        assert.deepEqual(gaps.behind, []);
        continue;
      }
      const month = months.find((item) => item.month === gaps.lastCompletableMonth)!;
      for (const item of gaps.behind) assert.ok(month.uncoveredCardIds.includes(item.cardAccountId), `seed ${seed} ${item.cardAccountId}`);
      // Independently: open cards expected there (from their opening day when a month applies) whose coverage stops early.
      const end = lastDayOf(month.month);
      const expected = input.cards.filter((item) => item.status !== 'closed').flatMap((item) => {
        const live = input.rows.filter((entry) => entry.cardAccountId === item.id && entry.status !== 'removed').map((entry) => entry.transactionDate).sort();
        const ranges = input.coverage.filter((entry) => entry.cardAccountId === item.id).flatMap((entry) => entry.ranges);
        const starts = [...live, ...ranges.map((range) => range.start)].sort();
        if (starts.length === 0) return [];
        const opening = item.openingMonth ?? null;
        const applies = opening !== null && starts[0] >= `${opening}-01`;
        const from = !applies ? starts[0] : starts[0].slice(0, 7) === opening ? starts[0] : `${opening}-01`;
        if (from > end) return [];
        const ends = ranges.map((range) => range.end).sort();
        const reach = ends.length > 0 ? ends[ends.length - 1] : null;
        return reach === null || reach < end ? [{ cardAccountId: item.id, coveredThrough: reach }] : [];
      });
      assert.deepEqual([...gaps.behind].sort(byCard), expected.sort(byCard), `seed ${seed}`);
      behind += gaps.behind.length;
    }
    assert.ok(behind >= 20 && later >= 10, `${behind} behind, ${later} later`);
  });

  it('answers exactly as before opening months for cards without one, or with one its evidence contradicts', () => {
    for (let seed = 301; seed <= 380; seed += 1) {
      const input = ledger(seed);
      const evidence = cardOpeningEvidence(input);
      const without = { ...input, cards: input.cards.map(({ id, status }) => ({ id, status })) };
      // Only the months that do not apply: none, null, or later than the month of the card's first known day.
      const unapplied = {
        ...input,
        cards: input.cards.map((item) => {
          const found = evidence.find((entry) => entry.cardAccountId === item.id)!;
          const contradiction = found.firstKnownDate === null ? null : shiftMonth(found.firstKnownDate.slice(0, 7), 1 + (seed % 3));
          return { ...item, openingMonth: seed % 2 === 0 ? null : contradiction };
        }),
      };
      const months = { from: '2025-01', to: day(760).slice(0, 7) };
      assert.equal(JSON.stringify(cardSpendingCoverageByMonth({ ...unapplied, ...months })), JSON.stringify(cardSpendingCoverageByMonth({ ...without, ...months })), `seed ${seed}`);
      assert.equal(JSON.stringify(cardSpendingCoverageByMonth(unapplied)), JSON.stringify(cardSpendingCoverageByMonth(without)), `seed ${seed} default months`);
      assert.equal(JSON.stringify(cardSpendingCoverageGaps(unapplied)), JSON.stringify(cardSpendingCoverageGaps(without)), `seed ${seed} gaps`);
      const range = { from: day(seed % 400), to: day((seed % 400) + 45) };
      assert.equal(JSON.stringify(cardSpendingCoverageForRange(unapplied, range)), JSON.stringify(cardSpendingCoverageForRange(without, range)), `seed ${seed} range`);
    }
  });

  it('counts a card in view as starting later exactly before its first known day, without a month', () => {
    for (let seed = 501; seed <= 540; seed += 1) {
      const input = ledger(seed);
      for (const found of cardOpeningEvidence(input)) {
        if (found.firstKnownDate === null) continue;
        const alone = { ...input, cards: [{ id: found.cardAccountId }] };
        for (const month of cardSpendingCoverageByMonth({ ...alone, from: '2024-11', to: '2026-12' })) {
          assert.equal(month.cardsStartingLater, lastDayOf(month.month) < found.firstKnownDate ? 1 : 0, `seed ${seed} ${month.month}`);
        }
      }
    }
  });

  it('with each card\'s prefilled month confirmed, completes every past month its cards are read for from their first day', () => {
    // The household the probe found: cards first seen at different times, the last only last month; each read from its
    // first known day (its first statement) through today.
    for (let seed = 601; seed <= 640; seed += 1) {
      const next = random(seed);
      const today = '2026-10-22';
      const firsts = Array.from({ length: 2 + Math.floor(next() * 5) }, () => day(Math.floor(next() * 600)));
      firsts.push('2026-09-14');
      const ids = firsts.map((_, index) => `card-${index}`);
      const rows = firsts.flatMap((first, index) => [row(ids[index], first), row(ids[index], nextDay(first), 'pending')]);
      const coverage = firsts.map((first, index) => covered(ids[index], [first, today]));
      const prefills = cardOpeningEvidence({ cards: ids.map((id) => ({ id })), rows, coverage });
      assert.deepEqual(prefills.map((item) => item.firstKnownDate), firsts);
      const range = { from: firsts.slice().sort()[0].slice(0, 7), to: '2026-10' };
      const before = cardSpendingCoverageByMonth({ cards: ids.map((id) => ({ id })), rows, coverage, today, ...range });
      const after = cardSpendingCoverageByMonth({ cards: prefills.map((item) => ({ id: item.cardAccountId, openingMonth: item.prefillMonth })), rows, coverage, today, ...range });
      // Before: nothing until the last card's month is over, and not that one (it starts on the 14th).
      assert.ok(before.every((month) => !month.complete), `seed ${seed}`);
      assert.ok(before.slice(0, -2).every((month) => month.cardsStartingLater >= 1), `seed ${seed}`);
      // After: every month that is over is complete; the month still going is not.
      assert.deepEqual(after.map((month) => [month.month, month.complete, month.cardsStartingLater]),
        after.map((month) => [month.month, month.month < '2026-10', 0]), `seed ${seed}`);
    }
  });
});
