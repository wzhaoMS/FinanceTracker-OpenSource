import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardSpendingPatterns,
  forecastCardSpending,
  type CardAccount,
  type CardForecastRow,
  type CardSpendingForecast,
  type CardSpendingPatterns,
} from '@finance-tracker/shared';

import { cardOptionLabel, formatMinor } from '../spendingFormat';
import {
  FORECAST_METALS_NOTE,
  FORECAST_METHOD_LABELS,
  FORECAST_NO_RANGE_NOTE,
  FORECAST_QUANTITY,
  FORECAST_TEMPLATES,
  anomalyMethodSentence,
  anomalySentences,
  backtestSentences,
  billSentence,
  billsMethodSentence,
  billsSentences,
  forecastCategoryLabels,
  forecastHeadline,
  forecastNotes,
  forecastScopeSentence,
  formatEstimate,
  gapSummaryText,
  methodSentence,
  monthSpan,
  paceSentences,
  range95Sentence,
  type ForecastSentence,
} from './forecastText';

// Synthetic ledgers only: fictional merchants, made-up amounts and dates.

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const SHORT_MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
/** A time window: a month and year, a day of a month, or a count of complete months or days. */
const TIME_WINDOW = new RegExp(`\\b(?:(?:${MONTHS}) \\d{4}|(?:${SHORT_MONTHS}) \\d{1,2}|\\d+ complete months?|\\d+ days)\\b`);
const BANNED = /\b(?:will|won't|always|never|guarantee[sd]?|certainly|definitely|surely)\b/i;
const NAMED_RANGE = /\b(?:80|95)% ranges?\b/g;

/** Why a sentence breaks the rules, if it does. A quoted name (`subject`) is data: its punctuation is not checked. */
function lintSentence(item: ForecastSentence): string[] {
  const problems: string[] = [];
  const text = item.subject ? item.text.split(item.subject).join('Name') : item.text;
  const bare = text.replace(/\d\.\d/g, '00');
  if (!bare.endsWith('.') || /[.!?]/.test(bare.slice(0, -1))) problems.push('not exactly one sentence');
  if (!/\d/.test(text)) problems.push('no number');
  if (!TIME_WINDOW.test(text)) problems.push('no time window');
  if (BANNED.test(text)) problems.push('a forbidden word');
  if (item.estimate && !/\bestimate\b/i.test(text)) problems.push('an estimate not called one');
  if (item.ranged && !/\b(?:80|95)% range\b/.test(text)) problems.push('a range not named');
  if (item.thin && /%|percent/i.test(text.replace(NAMED_RANGE, ''))) problems.push('a percentage on a thin category');
  // One name per concept (readability D7): the forecast's quantity is "spending without large one-offs".
  if (/\beveryday\b/i.test(text)) problems.push('the quantity by its old name');
  return problems;
}

// ---------------------------------------------------------------------------
// Synthetic answers from the real engines
// ---------------------------------------------------------------------------

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function monthsBefore(month: string, count: number): string[] {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, offset) => {
    const value = index - count + offset;
    return `${Math.floor(value / 12)}-${String((value % 12) + 1).padStart(2, '0')}`;
  });
}

const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const on = (month: string, day: number) => `${month}-${String(Math.min(day, daysIn(month))).padStart(2, '0')}`;

interface Scenario {
  name: string;
  today: string;
  /** Months of history before today's month, and how many of the latest are complete. */
  history: number;
  complete: number;
  /** Complete months left out (partial) in the middle. */
  partial?: string[];
  seed: number;
  bill?: { day: number } | null;
  /** A second monthly bill, at another merchant. */
  secondBill?: { day: number };
  travelEvery?: number;
  lastMonth?: 'high' | 'low';
  thisMonth?: { oneOff?: boolean; pending?: boolean; spike?: boolean; billMissing?: boolean };
  /** A large one-off in the fourth month back, kept or refunded in full. */
  pastOneOff?: 'kept' | 'refunded';
  monthSoFarComplete?: boolean | null;
}

function answer(scenario: Scenario): { forecast: CardSpendingForecast; patterns: CardSpendingPatterns } {
  const next = seeded(scenario.seed);
  const current = scenario.today.slice(0, 7);
  const today = Number(scenario.today.slice(8, 10));
  const past = monthsBefore(current, scenario.history);
  const rows: CardForecastRow[] = [];
  let sequence = 0;
  const add = (transactionDate: string, amountMinor: number, description: string, extra: Partial<CardForecastRow> = {}) => {
    sequence += 1;
    rows.push({
      id: `ft-${scenario.seed}-${sequence}`, cardAccountId: 'card-a', transactionDate, status: 'posted', amountMinor, currency: 'USD',
      kind: amountMinor < 0 ? 'refund' : 'purchase', description, merchant: null, issuerCategory: null, userCategory: null, ...extra,
    });
  };
  for (const [index, month] of [...past, current].entries()) {
    const last = month === current ? today : daysIn(month);
    const isLast = index === past.length - 1;
    const groceries = isLast && scenario.lastMonth === 'low' ? 1 : 10;
    for (let count = 0; count < groceries; count += 1) {
      add(on(month, 1 + Math.floor(next() * last)), 2_500 + Math.floor(next() * 3_000), 'SAMPLE GROCER #0012', { issuerCategory: 'Merchandise & Supplies-Groceries' });
    }
    const bistro = isLast && scenario.lastMonth === 'high' ? 12 : month === current && scenario.thisMonth?.spike ? 8 : 2;
    for (let count = 0; count < bistro; count += 1) {
      add(on(month, 1 + Math.floor(next() * Math.min(last, 6))), 4_000 + Math.floor(next() * 2_000), 'SAMPLE BISTRO', { issuerCategory: 'Restaurant-Restaurant' });
    }
    if (scenario.bill && (month !== current || (scenario.bill.day <= today && !scenario.thisMonth?.billMissing))) {
      add(on(month, scenario.bill.day), 1_599, 'SAMPLE STREAMING', { issuerCategory: 'Entertainment-Other Entertainment' });
    }
    if (scenario.secondBill && (month !== current || scenario.secondBill.day <= today)) {
      add(on(month, scenario.secondBill.day), 899, 'SAMPLE NEWS DAILY', { issuerCategory: 'Entertainment-Other Entertainment' });
    }
    if (scenario.travelEvery && index % scenario.travelEvery === 0 && month !== current) {
      add(on(month, 9), 20_000 + Math.floor(next() * 20_000), 'SAMPLE TRAVEL DESK', { issuerCategory: 'Travel-Travel Agencies' });
    }
  }
  if (scenario.thisMonth?.oneOff) add(on(current, 1), 450_000, 'SAMPLE ELECTRONICS STORE', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' });
  if (scenario.thisMonth?.pending) add(on(current, today), 3_300, 'SAMPLE BISTRO', { status: 'pending', issuerCategory: 'Restaurant-Restaurant' });
  if (scenario.pastOneOff) {
    const month = past[past.length - 4];
    add(on(month, 4), 380_000, 'SAMPLE TV SHOP', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' });
    if (scenario.pastOneOff === 'refunded') add(on(month, 20), -380_000, 'SAMPLE TV SHOP', { issuerCategory: 'Merchandise & Supplies-Electronics Stores' });
  }
  const complete = new Set(past.slice(past.length - scenario.complete).filter((month) => !scenario.partial?.includes(month)));
  const input = { today: scenario.today, currency: 'USD', completeMonths: complete, monthSoFarComplete: scenario.monthSoFarComplete ?? true };
  return { forecast: forecastCardSpending(rows, input), patterns: cardSpendingPatterns(rows, input) };
}

/** Every sentence the panel says for one answer, as the panel builds them. */
function allSentences(forecast: CardSpendingForecast, patterns: CardSpendingPatterns): ForecastSentence[] {
  const labels = forecastCategoryLabels([...forecast.categories.map((item) => item.category!), ...patterns.anomalies.flatMap((item) => (item.category ? [item.category] : []))]);
  const ranges95 = (series: CardSpendingForecast['categories'][number], label?: string) =>
    series.months.flatMap((_, index) => range95Sentence(series, index, forecast.currency, label) ?? []);
  const list = [
    ...paceSentences(forecast.pace, forecast.today, forecast.currency),
    forecastHeadline(forecast),
    ...forecastNotes(forecast),
    ...(forecast.total
      ? [methodSentence(forecast.total, 'All of it', forecast.currency), methodSentence(forecast.total, 'All of it', forecast.currency, { brief: true }),
        ...backtestSentences(forecast.total, forecast.currency), ...ranges95(forecast.total)]
      : []),
    ...forecast.categories.flatMap((item) => {
      const label = labels.get(item.category!) ?? item.category!;
      return [methodSentence(item, label, forecast.currency), ...backtestSentences(item, forecast.currency, label), ...ranges95(item, label)];
    }),
    ...anomalySentences(patterns, labels),
    anomalyMethodSentence(patterns.currency),
    ...billsSentences(patterns.bills, patterns.month, patterns.currency),
    billsMethodSentence(),
    ...patterns.bills.items.map(billSentence),
  ];
  return list;
}

const SCENARIOS: Scenario[] = [
  { name: 'nothing complete yet', today: '2026-10-05', history: 4, complete: 0, seed: 1, bill: null },
  { name: 'two complete months, a one-off this month', today: '2026-10-15', history: 6, complete: 2, seed: 2, bill: { day: 25 }, thisMonth: { oneOff: true } },
  { name: 'five complete months, a one-off and a pending charge this month', today: '2026-10-15', history: 8, complete: 5, seed: 3, bill: { day: 6 }, thisMonth: { oneOff: true, pending: true } },
  { name: 'ten complete months, the record of this month incomplete', today: '2026-10-20', history: 10, complete: 10, seed: 4, bill: { day: 28 }, secondBill: { day: 4 }, travelEvery: 3, monthSoFarComplete: false },
  { name: 'fourteen months, one partial, last month high, a one-off this month and one before', today: '2026-10-12', history: 16, complete: 14, partial: ['2026-03'], seed: 5, bill: { day: 6 }, travelEvery: 4, lastMonth: 'high', thisMonth: { oneOff: true }, pastOneOff: 'kept' },
  { name: 'fourteen months, last month low, the bistro busy this month', today: '2026-10-22', history: 14, complete: 14, seed: 6, bill: { day: 27 }, lastMonth: 'low', thisMonth: { spike: true } },
  { name: 'steady, two years and more, a one-off refunded in full', today: '2026-10-31', history: 27, complete: 26, seed: 7, bill: { day: 3 }, travelEvery: 2, pastOneOff: 'refunded' },
  { name: 'the first of the month', today: '2026-11-01', history: 13, complete: 12, seed: 8, bill: { day: 1 } },
  { name: 'this month\'s bill not in the record yet', today: '2026-10-18', history: 14, complete: 14, seed: 9, bill: { day: 9 }, thisMonth: { billMissing: true } },
];

describe('forecast words: every sentence is one honest sentence', () => {
  const produced = new Map<string, ForecastSentence>();
  const answers = SCENARIOS.map((scenario) => ({ scenario, ...answer(scenario) }));

  for (const { scenario, forecast, patterns } of answers) {
    test(`lints every sentence: ${scenario.name}`, () => {
      for (const item of allSentences(forecast, patterns)) {
        assert.deepEqual(lintSentence(item), [], item.text);
        if (!produced.has(item.template)) produced.set(item.template, item);
      }
    });
  }

  test('hand-made edge cases: no MASE, no range yet, untested, no estimate, no recurring charges, a name with punctuation, a late bill', () => {
    const base = answers.find((item) => item.scenario.name.startsWith('fourteen months, one partial'))!;
    const total = base.forecast.total!;
    const ranged = answers.find((item) => item.scenario.name.startsWith('fourteen months, last month low'))!.forecast.total!;
    const bill = base.patterns.bills.items[0];
    const unranged = { ...total, category: 'Dr. visits!', months: total.months.map((item) => ({ ...item, range80: null, range95: null })) };
    const edge: ForecastSentence[] = [
      ...backtestSentences({ ...total, backtest: { ...total.backtest!, mase: null, maseBenchmark: null } }, 'USD'),
      methodSentence(unranged, 'Dr. visits!', 'USD'),
      methodSentence({ ...unranged, tested: false }, 'Dr. visits!', 'USD'),
      methodSentence({ ...unranged, method: null, months: [], historyMonths: 1 }, 'Dr. visits!', 'USD'),
      range95Sentence({ ...ranged, category: 'Dr. visits!' }, 0, 'USD', 'Dr. visits!')!,
      forecastHeadline({ ...base.forecast, total: { ...total, months: total.months.map((item) => ({ ...item, range80: null, range95: null })) } }),
      ...billsSentences({ ...base.patterns.bills, activeCharges: 0, items: [], count: 0, totalMinor: 0, thisMonth: { ...base.patterns.bills.thisMonth, dueCount: 0, dueMinor: 0, chargedCount: 0, chargedMinor: 0 } }, '2026-10', 'USD'),
      ...billsSentences({ ...base.patterns.bills, activeCharges: 1, items: [], count: 0, totalMinor: 0, thisMonth: { ...base.patterns.bills.thisMonth, dueCount: 0, dueMinor: 0, chargedCount: 0, chargedMinor: 0 } }, '2026-10', 'USD'),
      billSentence({ ...bill, date: '2026-09-28', expectedBeforeToday: true, late: true }),
      ...paceSentences({ ...base.forecast.pace, historyMonths: 1, restMinor: null, typicalMinor: null, everydayProjectedMinor: null, everydayRange80: null, projectedMinor: null, projectedRange80: null }, '2026-10-12', 'USD'),
      ...paceSentences({ ...base.forecast.pace, historyMonths: 1, restMinor: null, typicalMinor: null, everydayProjectedMinor: null, everydayRange80: null, projectedMinor: null, projectedRange80: null, monthSoFarComplete: false }, '2026-10-12', 'USD'),
      ...paceSentences({ ...base.forecast.pace, oneOffsMinor: -25_000 }, '2026-10-12', 'USD'),
      ...forecastNotes({ ...base.forecast, fit: { ...base.forecast.fit!, oneOffPurchases: 0, oneOffPurchasesMinor: 0, oneOffRefundsMinor: 25_000, oneOffsMinor: -25_000 } }),
    ];
    for (const item of edge) {
      assert.deepEqual(lintSentence(item), [], item.text);
      if (!produced.has(item.template)) produced.set(item.template, item);
    }
  });

  test('makes every template, so no sentence goes unlinted', () => {
    assert.deepEqual([...FORECAST_TEMPLATES].filter((template) => !produced.has(template)), []);
  });

  test('the lint catches what it should', () => {
    const ok = { template: 'forecast-ranged', estimate: true, ranged: true, thin: false } as const;
    assert.deepEqual(lintSentence({ ...ok, text: 'Estimate for November 2026: $3,410 of spending without large one-offs, with an 80% range of $2,900 to $4,100.' }), []);
    assert.ok(lintSentence({ ...ok, text: 'Estimate for November 2026: $3,410 of everyday spending, with an 80% range of $2,900 to $4,100.' })
      .includes('the quantity by its old name'));
    const will = lintSentence({ ...ok, text: 'Spending will be $3,410 in November 2026, with an 80% range of $2,900 to $4,100.' });
    assert.ok(will.includes('a forbidden word') && will.includes('an estimate not called one'));
    assert.ok(lintSentence({ ...ok, text: 'Estimate: about $3,410 a month, 80% range $2,900 to $4,100.' }).includes('no time window'));
    assert.ok(lintSentence({ ...ok, text: 'Estimate for November 2026: $3,410. The 80% range is $2,900 to $4,100.' }).includes('not exactly one sentence'));
    assert.ok(lintSentence({ ...ok, text: 'Estimate for November 2026 is always about $3,410, 80% range $2,900 to $4,100.' }).includes('a forbidden word'));
    assert.ok(lintSentence({ ...ok, estimate: true, text: 'About $3,410 in November 2026, 80% range $2,900 to $4,100.' }).includes('an estimate not called one'));
    assert.ok(lintSentence({ ...ok, thin: true, text: 'Estimate for November 2026: $310 for travel, up 40%, 80% range $0 to $900.' }).includes('a percentage on a thin category'));
    assert.deepEqual(lintSentence({ ...ok, thin: true, text: 'Travel: estimate $310 for November 2026, 80% range $0 to $900.' }), []);
  });
});

describe('forecast words: exact sentences', () => {
  test('estimates are whole units; spent money keeps its cents', () => {
    assert.equal(formatEstimate(341_049, 'USD'), '$3,410');
    assert.equal(formatEstimate(-341_051, 'USD'), '-$3,411');
    assert.equal(formatEstimate(5_000, 'JPY'), '¥5,000');
  });

  test('the pace, the headline and a bill line', () => {
    const { forecast, patterns } = answer(SCENARIOS[5]);
    const { pace } = forecast;
    const said = paceSentences(pace, forecast.today, forecast.currency);
    // First the pace with its range, then how that range tested, then a typical month to compare it with.
    assert.deepEqual(said.map((item) => item.template), ['pace-everyday-ranged', 'pace-coverage', 'pace-typical']);
    assert.match(said[0].text, /^Estimate of spending without large one-offs for all of October 2026: \$[\d,]+, with an 80% range of \$[\d,]+ to \$[\d,]+, from \$[\d,]+\.\d\d spent through Oct 22 plus a typical rest of the month from the last 12 complete months\.$/);
    assert.equal(said[1].text, `Tested on those 12 complete months: the rest of the month fell inside the 80% range the other months gave in ${pace.everydayRange80!.coverage.inside} of 12.`);
    assert.match(said[2].text, /^A typical month of spending without large one-offs was \$[\d,]+\.\d\d over the last 12 complete months, their median\.$/);
    const headline = forecastHeadline(forecast);
    assert.equal(headline.template, 'forecast-ranged');
    assert.match(headline.text, /^Estimate for November 2026: \$[\d,]+ of spending without large one-offs, with an 80% range of \$[\d,]+ to \$[\d,]+\.$/);
    const bills = billsSentences(patterns.bills, patterns.month, patterns.currency);
    assert.deepEqual(bills.map((item) => item.text), [
      'Estimate: $16 in recurring bills still due in October 2026, 1 charge at its usual amount.',
      'Estimate: $32 in recurring bills from Oct 22 to Dec 21, 2 charges at their usual amounts.',
    ]);
    assert.equal(billSentence(patterns.bills.items[0]).text, 'Seen 13 times, September 2025 to September 2026.');
  });

  test('the month\'s total adds this month\'s one-offs once, labelled; a range says what it is and how it tested', () => {
    const { forecast } = answer(SCENARIOS[4]);
    const { pace } = forecast;
    const said = paceSentences(pace, forecast.today, forecast.currency);
    const sum = said.find((item) => item.template === 'pace-total-ranged')!;
    assert.equal(sum.text, `Estimate for all of October 2026 with the $4,500.00 of large one-offs already posted, counted once and not projected: `
      + `${formatEstimate(pace.projectedMinor!, 'USD')}, with an 80% range of ${formatEstimate(pace.projectedRange80!.lowerMinor, 'USD')} to `
      + `${formatEstimate(pace.projectedRange80!.upperMinor, 'USD')}.`);
    assert.equal(pace.projectedMinor, pace.everydayProjectedMinor! + 450_000);
    assert.equal(forecastNotes(forecast).find((item) => item.template === 'one-offs-left-out')!.text,
      'Estimates leave out large one-off purchases of $500.00 or more: 1 purchase for $3,800.00 in the 13 complete months fitted.');
    // Thirteen complete months test no range: the headline says why, in counts.
    assert.equal(forecastHeadline(forecast).template, 'forecast-no-range');
    assert.match(forecastHeadline(forecast).text, /; a range needs past estimates in 10 complete months to test it on, and there are \d\.$/);
    const total = answer(SCENARIOS[5]).forecast.total!;
    const range = total.months[0].range95!;
    assert.equal(range.basis, 'extended');
    assert.equal(range95Sentence(total, 0, 'USD')!.text, `Estimate for November 2026: ${formatEstimate(total.months[0].pointMinor, 'USD')}, with a 95% range of `
      + `${formatEstimate(range.lowerMinor, 'USD')} to ${formatEstimate(range.upperMinor, 'USD')}, widened from the 80% range (too few past estimates for its own); `
      + `${range.coverage.inside} of ${range.coverage.tested} past estimates fell inside their 95% ranges.`);
  });

  test('a one-off refunded in full is said to be refunded, never "none"', () => {
    const { forecast } = answer(SCENARIOS[6]);
    assert.deepEqual(forecast.fit && [forecast.fit.oneOffPurchases, forecast.fit.oneOffsMinor], [1, 0]);
    const notes = forecastNotes(forecast).map((item) => [item.template, item.text]);
    assert.deepEqual(notes.find(([template]) => template?.startsWith('one-offs')), ['one-offs-refunded',
      'Estimates leave out large one-off purchases of $500.00 or more: 1 purchase for $3,800.00 in the 26 complete months fitted, and $3,800.00 refunded for one-offs.']);
  });

  test('the month in progress is never compared, and the card says when it is', () => {
    for (const index of [3, 5]) {
      const { patterns } = answer(SCENARIOS[index]);
      const said = anomalySentences(patterns, new Map());
      assert.ok(patterns.anomalies.every((item) => item.month === '2026-09'));
      assert.equal(said[said.length - 1].text, 'October 2026 is compared with earlier months only once it is over and every card\'s record of it is complete.');
    }
  });

  test('a bill expected before today: late only against a complete month\'s record', () => {
    const { patterns } = answer(SCENARIOS[8]);
    const bill = patterns.bills.items.find((item) => item.expectedBeforeToday)!;
    assert.deepEqual([bill.date, bill.late], ['2026-10-09', false]);
    assert.equal(billSentence(bill).text, 'Seen 12 times, October 2025 to September 2026; expected Oct 9, and not in the record yet.');
    assert.equal(billSentence({ ...bill, date: '2026-09-28', late: true }).text,
      'Seen 12 times, October 2025 to September 2026; expected Sep 28 and not in September 2026\'s record, which is complete.');
  });

  test('says why there is no forecast, in numbers', () => {
    const { forecast } = answer(SCENARIOS[0]);
    assert.equal(forecastHeadline(forecast).text, 'No forecast yet: it needs 3 complete months of card data, and there are 0 through September 2026.');
    const { forecast: two } = answer(SCENARIOS[1]);
    assert.equal(forecastHeadline(two).text, 'No forecast yet: it needs 3 complete months of card data, and there are 2 through September 2026.');
  });

  test('the lead says what an estimate or its range still needs, in counts, and when this month\'s record may be short', () => {
    // Two complete months: no estimate, and why.
    const two = answer(SCENARIOS[1]).forecast;
    assert.deepEqual(paceSentences(two.pace, two.today, two.currency).filter((item) => item.template === 'pace-spent-only').map((item) => item.text),
      ['No estimate for all of October 2026 yet: it needs 3 complete months of card data, and there are 2.']);
    // Five: an estimate, with no range yet, and why.
    const five = answer(SCENARIOS[2]).forecast;
    const said = paceSentences(five.pace, five.today, five.currency);
    assert.deepEqual(said.slice(0, 2).map((item) => item.template), ['pace-everyday', 'pace-no-range']);
    assert.equal(said[1].text, 'An 80% range for October 2026 needs 10 complete months of card data, and there are 5.');
    // Ten, with this month's record incomplete: the amount the lead shows, and the estimate built on it, may be low; and
    // what is in the record so far is called recorded, never spent.
    const ten = answer(SCENARIOS[3]).forecast;
    const tenSaid = paceSentences(ten.pace, ten.today, ten.currency);
    assert.equal(tenSaid.find((item) => item.template === 'pace-record-incomplete')!.text,
      `Some cards' records for October 2026 are not complete yet, so the ${formatMinor(ten.pace.everydaySpentMinor, 'USD')} `
      + 'recorded so far, and the estimate built on it, may be low.');
    assert.match(tenSaid[0].text, new RegExp(`, from \\${formatMinor(ten.pace.everydaySpentMinor, 'USD')} recorded through Oct 20 plus `));
    assert.ok(tenSaid.every((item) => !/\bspent\b/.test(item.text)), 'an incomplete record says recorded');
  });

  test('how each row was estimated, in one line: its method, what it learned from and its miss; or why it has no test or range', () => {
    const steady = answer(SCENARIOS[5]).forecast.total!;
    const backtest = steady.backtest!;
    assert.equal(methodSentence(steady, 'All of it', 'USD').text, `All of it: ${FORECAST_METHOD_LABELS[steady.method!]}, learned from `
      + `${steady.historyMonths} complete months, tested on ${monthSpan(backtest.from, backtest.to)} and off by ${formatEstimate(backtest.maeMinor, 'USD')} a month on average.`);
    // In brief, beside the row's tests in full.
    assert.equal(methodSentence(steady, 'All of it', 'USD', { brief: true }).text,
      `All of it: ${FORECAST_METHOD_LABELS[steady.method!]}, learned from ${steady.historyMonths} complete months.`);
    // Thirteen complete months: tested, with no range yet.
    const thirteen = answer(SCENARIOS[4]).forecast.total!;
    assert.match(methodSentence(thirteen, 'All of it', 'USD').text,
      /; no range until its past estimates cover 10 complete months \(now \d\)\.$/);
    assert.equal(methodSentence({ ...steady, tested: false, historyMonths: 4 }, 'Sample travel', 'USD').text,
      'Sample travel: the median of its last 4 complete months, too few to test it.');
    assert.equal(methodSentence({ ...steady, method: null, months: [], historyMonths: 2 }, 'Sample travel', 'USD').text,
      'Sample travel: no estimate from 2 complete months; an estimate needs 3.');
  });

  test('what makes a month unusual and a charge a bill, in the engines\' own thresholds', () => {
    assert.equal(anomalyMethodSentence('USD').text, 'A complete month is unusual when it is more than 3 robust standard deviations, and at least $50, '
      + 'from the median of up to 12 complete months before it, with at least 6 of them.');
    assert.equal(billsMethodSentence().text, 'A charge is a recurring bill once its payments repeat on a regular rhythm; the calendar shows those '
      + 'due in the next 60 days, each at its usual amount.');
  });

  test('one name for the quantity, and the scope line: whose cards, as of when', () => {
    assert.equal(FORECAST_QUANTITY, 'Spending without large one-offs');
    assert.equal(FORECAST_METALS_NOTE, 'Confirmed precious-metal purchases are excluded from every figure here, including the month total with one-offs.');
    assert.equal(FORECAST_NO_RANGE_NOTE, '“No range yet”: a range needs past estimates in 10 complete months to test it on.');
    const card: CardAccount = {
      id: 'card-sample', issuer: 'amex', owner: 'alex', nickname: 'Sample Gold', last5: '90004', currency: 'USD', status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const today = '2026-10-22';
    assert.equal(forecastScopeSentence({ today }), 'Estimates as of Oct 22, for everyone\'s cards.');
    assert.equal(forecastScopeSentence({ today, owner: 'casey' }), 'Estimates as of Oct 22, for Casey\'s cards.');
    assert.equal(forecastScopeSentence({ today, owner: 'joint' }), 'Estimates as of Oct 22, for joint cards.');
    assert.equal(forecastScopeSentence({ today, cardAccountId: card.id, card }), `Estimates as of Oct 22, for ${cardOptionLabel(card)}.`);
    assert.equal(forecastScopeSentence({ today, owner: 'alex', cardAccountId: card.id, card }), `Estimates as of Oct 22, for ${cardOptionLabel(card)}.`);
    // The API applies both: a card of someone other than the chosen person says so.
    assert.equal(forecastScopeSentence({ today, owner: 'casey', cardAccountId: card.id, card }),
      `Estimates as of Oct 22, for ${cardOptionLabel(card)}, with Person set to Casey.`);
    assert.equal(forecastScopeSentence({ today, cardAccountId: 'card-gone', card: null }), 'Estimates as of Oct 22, for the chosen card.');
    assert.match(cardOptionLabel(card), / · Alex$/);
  });

  test('the cards keeping months from counting, counted once each, in words that claim no missing statement', () => {
    assert.equal(gapSummaryText({ behind: [], startingLater: [] }), null);
    assert.equal(gapSummaryText({ behind: [{ cardAccountId: 'a' }], startingLater: [] }), '1 card in view keeps some months from counting yet.');
    assert.equal(gapSummaryText({ behind: [], startingLater: [{ cardAccountId: 'b' }] }), '1 card in view keeps some months from counting yet.');
    // A card both behind and first seen later is one card.
    assert.equal(gapSummaryText({ behind: [{ cardAccountId: 'a' }, { cardAccountId: 'b' }], startingLater: [{ cardAccountId: 'b' }, { cardAccountId: 'c' }] }),
      '3 cards in view keep some months from counting yet.');
  });
});
