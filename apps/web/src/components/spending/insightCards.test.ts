import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardSpendingInsights, DuplicateCharge, RecurringCharge } from '@finance-tracker/shared';

import { buildInsightCards, insightQuery, type InsightCard } from './insightCards';
import { spendingPeriodRange, type SpendingPeriod } from './spendingFormat';

// Synthetic findings only: made-up merchants and amounts.
const TODAY = '2026-10-16';
const NONE = { feesMinor: 0, interestMinor: 0, foreignFeesMinor: 0, reversalsMinor: 0 };

const ask = (period: SpendingPeriod, month = '2026-10') => insightQuery(period, spendingPeriodRange(period, month, TODAY), month, TODAY);
const thisMonth = ask('month').context;
const ninetyDays = ask('last90').context;

function findings(patch: Partial<CardSpendingInsights> = {}): CardSpendingInsights {
  return {
    currency: 'USD',
    month: '2026-10',
    today: TODAY,
    period: { from: '2026-10-01', to: TODAY, baseline: { from: '2026-09-01', to: '2026-09-16' } },
    spendingMinor: 0,
    baselineMinor: 0,
    pace: null,
    largePurchases: null,
    movers: [],
    merchantMovers: [],
    recurring: [],
    recurringChanges: { started: [], priceUps: [], stopped: [] },
    duplicates: [],
    newMerchants: [],
    pendingRefunds: null,
    costs: { period: NONE, year: { year: '2026', ...NONE } },
    ...patch,
  };
}

function recurring(merchant: string, patch: Partial<RecurringCharge> = {}): RecurringCharge {
  return {
    key: merchant, merchant, cadence: 'monthly', fixed: true, typicalMinor: 1500, lastMinor: 1500, firstDate: '2026-01-05',
    lastDate: '2026-10-05', nextDate: '2026-11-04', occurrences: 10, monthlyMinor: 1500, active: true, priceChange: null,
    cardAccountIds: ['card-a'], ...patch,
  };
}

function duplicate(first: string, merchant: string, key: string, amountMinor: number, dates: [string, string]): DuplicateCharge {
  return { ids: [first, `${first}-twin`], merchant, key, amountMinor, dates, cardAccountId: 'card-a' };
}

const summary = (cards: InsightCard[]) => cards.map((card) => [card.kind, card.title]);

test('insights ask for the period shown against what its comparison card compares it with, in its words', () => {
  assert.deepEqual(ask('month'), {
    request: { month: '2026-10', today: TODAY },
    context: { period: 'this month', baseline: 'by this day last month', heading: 'This month so far, against last month to this day' },
  });
  assert.deepEqual(ask('month', '2026-08'), {
    request: { month: '2026-08', today: TODAY },
    context: { period: 'in August 2026', baseline: 'in July 2026', heading: 'August 2026, against July 2026' },
  });
  const span = (period: SpendingPeriod) => {
    const { request, context } = ask(period);
    return [request.from, request.to, request.baselineFrom, request.baselineTo, request.month, context.heading];
  };
  assert.deepEqual(span('last60'), ['2026-08-18', TODAY, '2026-06-19', '2026-08-17', '2026-10', 'The last 60 days, against the 60 days before']);
  assert.deepEqual(span('last90'), ['2026-07-19', TODAY, '2026-04-20', '2026-07-18', '2026-10', 'The last 90 days, against the 90 days before']);
  assert.deepEqual(span('last6m'), ['2026-04-17', TODAY, '2025-04-17', '2025-10-16', '2026-10', 'The last 6 months, against the same 6 months last year']);
  assert.deepEqual(span('last12m'), ['2025-10-17', TODAY, '2024-10-17', '2025-10-16', '2026-10', 'The last 12 months, against the 12 months before']);
  assert.deepEqual(span('ytd'), ['2026-01-01', TODAY, '2025-01-01', '2025-10-16', '2026-10', '2026 to date, against 2025 to the same date']);
  assert.deepEqual(ninetyDays, { period: 'in the last 90 days', baseline: 'in the 90 days before', heading: 'The last 90 days, against the 90 days before' });
});

test('one card per kind: the pace leads, a possible duplicate follows, the rest by the money they are about', () => {
  const cards = buildInsightCards(findings({
    spendingMinor: 900000,
    baselineMinor: 220000,
    pace: {
      daysElapsed: 16, daysInMonth: 31, spentMinor: 900000, pendingMinor: 0, typicalToDateMinor: 200000, typicalMonthMinor: 400000,
      projectedMinor: 1100000, historyMonths: 3, largeMinor: 700000, largeCount: 2,
    },
    largePurchases: {
      thresholdMinor: 120000, count: 2, totalMinor: 700000, share: 700000 / 900000, coreMinor: 200000, baselineCoreMinor: 190000,
      items: [
        { id: 'row-1', merchant: 'SAMPLE DEVICES INC ROUND ROCK TX', key: 'SAMPLE DEVICES INC ROUND ROCK', amountMinor: 500000, date: '2026-10-02', category: 'Electronics', refundedMinor: 0, firstTime: false },
        { id: 'row-2', merchant: 'AplPay FABRIKAM FURNITURE SEATTLE WA', key: 'FABRIKAM FURNITURE', amountMinor: 200000, date: '2026-10-09', category: 'Home', refundedMinor: 0, firstTime: true },
      ],
    },
    duplicates: [duplicate('row-3', 'SQ *CONTOSO CAFE', 'CONTOSO CAFE', 4500, ['2026-10-03', '2026-10-04'])],
    movers: [{ category: 'Dining', currentMinor: 60000, typicalMinor: 30000, deltaMinor: 30000, share: 1, drivers: [{ key: 'CONTOSO CAFE', merchant: 'CONTOSO CAFE', deltaMinor: 25000 }] }],
    merchantMovers: [
      { key: 'CONTOSO CAFE', merchant: 'CONTOSO CAFE', currentMinor: 40000, baselineMinor: 15000, deltaMinor: 25000, share: 25000 / 15000 },
      { key: 'NORTHWIND GROCERY', merchant: 'NORTHWIND GROCERY #12', currentMinor: 10000, baselineMinor: 30000, deltaMinor: -20000, share: -2 / 3 },
    ],
    costs: { period: { ...NONE, feesMinor: 300, foreignFeesMinor: 300 }, year: { year: '2026', ...NONE, feesMinor: 300, foreignFeesMinor: 300 } },
  }), thisMonth);
  assert.deepEqual(summary(cards), [
    ['pace', 'On pace for $11,000.00 this month'],
    ['duplicates', 'Possible duplicate at Contoso Cafe'],
    ['large', '2 large purchases: $7,000.00'],
    ['category', 'Dining up $300.00 (+100%)'],
    // Contoso Cafe already explains Dining: only the merchant no card names gets its own.
    ['merchants', 'Northwind Grocery down $200.00 (−67%)'],
    ['costs', '$3.00 in interest and fees'],
  ]);
  const [pace, check, large, dining, grocery, costs] = cards;
  assert.equal(pace.detail, '$4,000.00 without the 2 large purchases ($7,000.00), vs a usual $4,000.00 (last 3 months, large purchases aside). $9,000.00 so far vs $2,000.00 by the 16th in a usual month.');
  assert.equal(pace.tone, 'info');
  assert.deepEqual(check.action, { label: 'Open', target: { type: 'row', id: 'row-3-twin' } });
  assert.equal(large.detail, '78% of your spending this month. Without them: $2,000.00, in line with $1,900.00 by this day last month.');
  // Each purchase under its cleaned name, opening its own row.
  assert.deepEqual(large.items.map((item) => [item.label, item.note, item.amount, item.target]), [
    ['Sample Devices', 'Oct 2', '$5,000.00', { type: 'row', id: 'row-1' }],
    ['Fabrikam Furniture', 'Oct 9 · first time here', '$2,000.00', { type: 'row', id: 'row-2' }],
  ]);
  assert.equal(dining.detail, '$600.00 vs $300.00 by this day last month. Mostly Contoso Cafe (+$250.00).');
  assert.deepEqual(dining.action, { label: 'Show', target: { type: 'category', category: 'Dining' } });
  // Show filters by the exact group key; the chip cleans the name the same way.
  assert.deepEqual(grocery.action, { label: 'Show', target: { type: 'merchant', key: 'NORTHWIND GROCERY', name: 'NORTHWIND GROCERY #12' } });
  assert.equal(costs.detail, 'This month: fees $3.00 (foreign transaction $3.00). 2026 so far: $3.00, of which foreign transaction fees $3.00.');
});

test('several findings of a kind share one card listing each, and every item keeps its own target', () => {
  const cards = buildInsightCards(findings({
    duplicates: [
      duplicate('row-1', 'CONTOSO AIRLINES', 'CONTOSO AIRLINES', 41200, ['2026-09-21', '2026-09-22']),
      duplicate('row-2', 'SQ *CONTOSO CAFE', 'CONTOSO CAFE', 4500, ['2026-10-03', '2026-10-04']),
    ],
    newMerchants: [
      { id: 'row-3', merchant: 'TAILSPIN TOYS', key: 'TAILSPIN TOYS', amountMinor: 30000, date: '2026-09-02' },
      { id: 'row-4', merchant: 'WINGTIP TAILOR LLC SEATTLE WA', key: 'WINGTIP TAILOR LLC SEATTLE', amountMinor: 20000, date: '2026-08-11' },
    ],
    pendingRefunds: {
      count: 2, totalMinor: 5500, ids: ['row-5', 'row-6'],
      items: [
        { id: 'row-5', merchant: 'SAMPLE SHOES', key: 'SAMPLE SHOES', amountMinor: 4500, date: '2026-10-10' },
        { id: 'row-6', merchant: 'SAMPLE SOCKS', key: 'SAMPLE SOCKS', amountMinor: 1000, date: '2026-09-20' },
      ],
    },
    recurringChanges: {
      started: [recurring('SAMPLE MUSIC', { firstDate: '2026-08-12', typicalMinor: 999, lastMinor: 999, monthlyMinor: 999 })],
      priceUps: [
        recurring('SAMPLE STREAM', { typicalMinor: 1799, lastMinor: 1799, monthlyMinor: 1799, priceChange: { fromMinor: 1549, toMinor: 1799, since: '2026-09-05' } }),
        recurring('SAMPLE NEWS', { typicalMinor: 900, lastMinor: 900, monthlyMinor: 900, priceChange: { fromMinor: 700, toMinor: 900, since: '2026-09-05' } }),
      ],
      stopped: [recurring('SAMPLE GYM', { active: false, typicalMinor: 4000, monthlyMinor: 4000, lastDate: '2026-07-10', nextDate: '2026-08-09' })],
    },
  }), ninetyDays);
  assert.deepEqual(summary(cards), [
    ['duplicates', '2 possible duplicate charges'],
    ['new-merchants', '2 first-time merchants: $500.00'],
    ['recurring-stopped', 'Sample Gym may have stopped'],
    ['recurring-new', 'New monthly charge: Sample Music'],
    ['pending-refunds', '2 refunds pending: $55.00'],
    ['recurring-up', '2 price increases: $54.00 more a year'],
  ]);
  // A merchant a first-time card already names gets no merchant-change card of its own.
  const named = buildInsightCards(findings({
    newMerchants: [{ id: 'row-3', merchant: 'TAILSPIN TOYS', key: 'TAILSPIN TOYS', amountMinor: 30000, date: '2026-09-02' }],
    merchantMovers: [{ key: 'TAILSPIN TOYS', merchant: 'TAILSPIN TOYS', currentMinor: 30000, baselineMinor: 0, deltaMinor: 30000, share: null }],
  }), ninetyDays);
  assert.deepEqual(summary(named), [['new-merchants', 'First time at Tailspin Toys: $300.00']]);
  const [duplicates, fresh, stopped, started, refunds, priceUps] = cards;
  assert.deepEqual(duplicates.items.map((item) => [item.label, item.note, item.amount, item.target]), [
    ['Contoso Cafe', 'Oct 3 and Oct 4', '$45.00', { type: 'row', id: 'row-2-twin' }],
    ['Contoso Airlines', 'Sep 21 and Sep 22', '$412.00', { type: 'row', id: 'row-1-twin' }],
  ]);
  assert.deepEqual(fresh.items.map((item) => [item.label, item.target]), [
    ['Tailspin Toys', { type: 'row', id: 'row-3' }],
    ['Wingtip Tailor', { type: 'row', id: 'row-4' }],
  ]);
  assert.equal(stopped.detail, 'Last charged Jul 10, 2026; the next monthly $40.00 was due about Aug 9. About $40.00 a month less.');
  assert.deepEqual(stopped.action, { label: 'Show', target: { type: 'merchant', key: 'SAMPLE GYM', name: 'SAMPLE GYM' } });
  assert.equal(started.detail, '$9.99 since Aug 12: about $119.88 a year.');
  assert.deepEqual(refunds.items.map((item) => [item.label, item.amount, item.target]), [
    ['Sample Shoes', '$45.00', { type: 'row', id: 'row-5' }],
    ['Sample Socks', '$10.00', { type: 'row', id: 'row-6' }],
  ]);
  assert.deepEqual(priceUps.items.map((item) => [item.label, item.note, item.amount, item.target.type]), [
    ['Sample Stream', '$15.49 → $17.99 monthly', '+$2.50', 'merchant'],
    ['Sample News', '$7.00 → $9.00 monthly', '+$2.00', 'merchant'],
  ]);
});

test('a span speaks of its own days and its own comparison, and a lone finding gets its own action', () => {
  const cards = buildInsightCards(findings({
    period: { from: '2026-07-19', to: TODAY, baseline: { from: '2026-04-20', to: '2026-07-18' } },
    largePurchases: {
      thresholdMinor: 80000, count: 6, totalMinor: 900000, share: 0.6, coreMinor: 600000, baselineCoreMinor: 450000,
      items: [1, 2, 3, 4, 5].map((n) => ({ id: `row-${n}`, merchant: `SAMPLE STORE ${n}`, key: `SAMPLE STORE ${n}`, amountMinor: 200000 - n * 10000, date: '2026-09-01', category: 'Home', refundedMinor: 0, firstTime: false })),
    },
    movers: [{ category: 'Travel', currentMinor: 82400, typicalMinor: 0, deltaMinor: 82400, share: null, drivers: [] }],
    merchantMovers: [{ key: 'CONTOSO AIRLINES', merchant: 'CONTOSO AIRLINES', currentMinor: 82400, baselineMinor: 0, deltaMinor: 82400, share: null }],
    newMerchants: [{ id: 'row-9', merchant: 'TAILSPIN TOYS', key: 'TAILSPIN TOYS', amountMinor: 30000, date: '2026-09-02' }],
    pendingRefunds: { count: 1, totalMinor: 4500, ids: ['row-8'], items: [{ id: 'row-8', merchant: 'SAMPLE SHOES #4', key: 'SAMPLE SHOES', amountMinor: 4500, date: '2026-10-10' }] },
    recurringChanges: {
      started: [],
      priceUps: [recurring('SAMPLE STREAM', { typicalMinor: 1799, lastMinor: 1799, monthlyMinor: 1799, priceChange: { fromMinor: 1549, toMinor: 1799, since: '2026-09-05' } })],
      stopped: [],
    },
    costs: { period: { ...NONE, interestMinor: 2400 }, year: { year: '2026', ...NONE, interestMinor: 2400, feesMinor: 9500 } },
  }), ninetyDays);
  const byKind = new Map(cards.map((card) => [card.kind, card]));
  assert.equal(byKind.get('large')?.detail, '60% of your spending in the last 90 days. Without them: $6,000.00, up 33% on $4,500.00 in the 90 days before. The 5 largest are listed.');
  assert.equal(
    buildInsightCards(findings({ largePurchases: {
      thresholdMinor: 80000, count: 1, totalMinor: 90000, share: 0.5, coreMinor: 90000, baselineCoreMinor: 0,
      items: [{ id: 'row-1', merchant: 'SAMPLE STORE', key: 'SAMPLE STORE', amountMinor: 90000, date: '2026-09-01', category: 'Home', refundedMinor: 0, firstTime: false }],
    } }), ninetyDays)[0].detail,
    '50% of your spending in the last 90 days. Without it: $900.00, with nothing recorded in the 90 days before.',
  );
  // Everyday spending many times what it was reads as the two amounts, not as a percentage in the thousands.
  assert.equal(
    buildInsightCards(findings({ largePurchases: {
      thresholdMinor: 80000, count: 1, totalMinor: 620000, share: 620000 / 660000, coreMinor: 40000, baselineCoreMinor: 1700,
      items: [{ id: 'row-1', merchant: 'SAMPLE STORE', key: 'SAMPLE STORE', amountMinor: 620000, date: '2026-10-05', category: 'Home', refundedMinor: 0, firstTime: true }],
    } }), thisMonth)[0].detail,
    '94% of your spending this month. Without it: $400.00, against $17.00 by this day last month.',
  );
  assert.equal(byKind.get('category')?.title, 'Travel up $824.00');
  assert.equal(byKind.get('category')?.detail, '$824.00 in the last 90 days, none in the 90 days before.');
  assert.deepEqual([byKind.get('merchants')?.title, byKind.get('merchants')?.detail], ['Contoso Airlines up $824.00', '$824.00 in the last 90 days, none in the 90 days before.']);
  assert.deepEqual(byKind.get('new-merchants')?.action, { label: 'Open', target: { type: 'row', id: 'row-9' } });
  assert.equal(byKind.get('pending-refunds')?.title, '$45.00 refund pending from Sample Shoes');
  assert.deepEqual(byKind.get('pending-refunds')?.action, { label: 'Open', target: { type: 'row', id: 'row-8' } });
  assert.deepEqual([byKind.get('recurring-up')?.title, byKind.get('recurring-up')?.detail], [
    'Sample Stream went up to $17.99', 'Was $15.49, monthly; last charged Oct 5. About $30.00 more a year.',
  ]);
  assert.equal(byKind.get('costs')?.detail, 'In the last 90 days: interest $24.00. 2026 so far: $119.00.');
  // Nothing in the period: the year's interest and fees still show, last.
  const quiet = buildInsightCards(findings({ costs: { period: NONE, year: { year: '2026', ...NONE, feesMinor: 9500 } } }), ninetyDays);
  assert.deepEqual(summary(quiet), [['costs', '$95.00 in interest and fees in 2026']]);
  assert.deepEqual(buildInsightCards(findings(), ninetyDays), []);
});

test('the pace without large purchases, early in the month, and with pending charges', () => {
  const pace = { daysElapsed: 16, daysInMonth: 31, spentMinor: 150000, pendingMinor: 5000, typicalToDateMinor: 100000, typicalMonthMinor: 200000, projectedMinor: 250000, historyMonths: 3, largeMinor: 0, largeCount: 0 };
  const [usual] = buildInsightCards(findings({ pace }), thisMonth);
  assert.deepEqual([usual.title, usual.tone], ['On pace for $2,500.00 this month', 'warn']);
  assert.equal(usual.detail, 'Usual month $2,000.00 (last 3 months, large purchases aside). $1,500.00 so far vs $1,000.00 by the 16th in a usual month; $50.00 pending, not counted yet.');
  // One large purchase explains the month: without it the pace is usual.
  const [explained] = buildInsightCards(findings({ pace: { ...pace, largeMinor: 60000, largeCount: 1 } }), thisMonth);
  assert.equal(explained.tone, 'info');
  assert.match(explained.detail, /^\$1,900\.00 without the large purchase \(\$600\.00\), vs a usual \$2,000\.00/);
  const [early] = buildInsightCards(findings({ pace: { ...pace, daysElapsed: 3, projectedMinor: null, pendingMinor: 0 } }), thisMonth);
  assert.deepEqual([early.title, early.detail], ['$1,500.00 spent so far', '$1,500.00 so far vs $1,000.00 by the 3rd in a usual month.']);
  // A refund this month for last month's large purchase: the month without it.
  const [refunded] = buildInsightCards(findings({ pace: { ...pace, largeMinor: -50000, largeCount: 0 } }), thisMonth);
  assert.match(refunded.detail, /^\$3,000\.00 without refunds for large purchases \(\$500\.00\), vs a usual \$2,000\.00/);
  assert.equal(refunded.tone, 'warn');
});

test('takes turns between what changed, what repeats and what to check, and leaves small amounts for last', () => {
  const mover = (category: string, deltaMinor: number) => ({ category, currentMinor: deltaMinor + 100000, typicalMinor: 100000, deltaMinor, share: deltaMinor / 100000, drivers: [] });
  const cards = buildInsightCards(findings({
    largePurchases: {
      thresholdMinor: 100000, count: 1, totalMinor: 700000, share: 0.5, coreMinor: 700000, baselineCoreMinor: 650000,
      items: [{ id: 'row-1', merchant: 'SAMPLE STORE', key: 'SAMPLE STORE', amountMinor: 700000, refundedMinor: 50000, date: '2026-10-02', category: 'Home', firstTime: false }],
    },
    movers: [mover('Merchandise & Supplies-Computer Supplies', 400000), mover('Merchandise & Supplies-Groceries', -60000), mover('Travel-Airline', 90000)],
    recurringChanges: {
      started: [],
      priceUps: [recurring('SAMPLE NEWS', { typicalMinor: 900, monthlyMinor: 900, priceChange: { fromMinor: 700, toMinor: 900, since: '2026-10-05' } })],
      stopped: [recurring('SAMPLE GYM', { active: false, typicalMinor: 4000, monthlyMinor: 4000, lastDate: '2026-08-10', nextDate: '2026-09-09' })],
    },
    costs: { period: { ...NONE, feesMinor: 300 }, year: { year: '2026', ...NONE, feesMinor: 300 } },
  }), thisMonth);
  assert.deepEqual(summary(cards), [
    // First turn: the largest of each kind, so the stopped gym comes before the second category change.
    ['large', '1 large purchase: $7,000.00'],
    ['category', 'Computer Supplies up $4,000.00 (+400%)'],
    ['recurring-stopped', 'Sample Gym may have stopped'],
    ['category', 'Airline up $900.00 (+90%)'],
    ['category', 'Groceries down $600.00 (−60%)'],
    // About less than $50 (a year, for a price rise): after everything else.
    ['recurring-up', 'Sample News went up to $9.00'],
    ['costs', '$3.00 in interest and fees'],
  ]);
  assert.equal(cards[0].items[0].note, 'Oct 2 · $500.00 refunded');
  // Show keeps the full category even where the card shortens it.
  assert.deepEqual(cards[1].action, { label: 'Show', target: { type: 'category', category: 'Merchandise & Supplies-Computer Supplies' } });
  // A change many times its comparison, or past all of it, reads as an amount alone.
  const [huge, below] = buildInsightCards(findings({ movers: [mover('Shopping', 900000), { ...mover('Fees', -150000), share: -1.5 }] }), thisMonth);
  assert.deepEqual([huge.title, below.title], ['Shopping up $9,000.00', 'Fees down $1,500.00']);
});

test('names every finding of a kind in its title, and lists the five that matter most', () => {
  const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];
  const cards = buildInsightCards(findings({
    duplicates: dates.map((date, index) => duplicate(`row-${index}`, `SAMPLE CAFE ${'ABCDEFG'[index]}`, `SAMPLE CAFE ${'ABCDEFG'[index]}`, 3000, [date, date])),
    newMerchants: dates.map((date, index) => ({ id: `new-${index}`, merchant: `SAMPLE SHOP ${'ABCDEFG'[index]}`, key: `SAMPLE SHOP ${'ABCDEFG'[index]}`, amountMinor: 20000 + index, date })),
  }), thisMonth);
  const [duplicates, fresh] = cards;
  assert.equal(duplicates.title, '7 possible duplicate charges');
  assert.match(duplicates.detail, /The 5 latest are listed\.$/);
  assert.deepEqual(duplicates.items.map((item) => item.note), ['Oct 7 and Oct 7', 'Oct 6 and Oct 6', 'Oct 5 and Oct 5', 'Oct 4 and Oct 4', 'Oct 3 and Oct 3']);
  assert.equal(fresh.title, '7 first-time merchants: $1,400.21');
  assert.match(fresh.detail, /The 5 largest are listed\.$/);
  assert.equal(fresh.items.length, 5);
  // Recurring cards list the five that cost the most a month, each with its rhythm.
  const [stopped] = buildInsightCards(findings({
    recurringChanges: {
      started: [],
      priceUps: [],
      stopped: dates.map((date, index) => recurring(`SAMPLE CLUB ${index + 1}`, {
        active: false, cadence: index === 0 ? 'quarterly' : 'monthly', typicalMinor: 1000 * (index + 1), monthlyMinor: index === 0 ? 9000 : 1000 * (index + 1), lastDate: date,
      })),
    },
  }), thisMonth);
  assert.equal(stopped.title, '7 recurring charges may have stopped');
  assert.match(stopped.detail, /The 5 largest are listed\.$/);
  assert.deepEqual(stopped.items.map((item) => [item.label, item.note]), [
    ['Sample Club 1', 'quarterly, last Oct 1'],
    ['Sample Club 7', 'monthly, last Oct 7'],
    ['Sample Club 6', 'monthly, last Oct 6'],
    ['Sample Club 5', 'monthly, last Oct 5'],
    ['Sample Club 4', 'monthly, last Oct 4'],
  ]);
});

test('a split large purchase names its categories, largest first, on its line', () => {
  const [card] = buildInsightCards(findings({ largePurchases: {
    thresholdMinor: 80000, count: 2, totalMinor: 300000, share: 0.5, coreMinor: 300000, baselineCoreMinor: null,
    items: [
      {
        id: 'row-1', merchant: 'SAMPLE STORE', key: 'SAMPLE STORE', amountMinor: 200000, date: '2026-10-05', category: 'Electronics', refundedMinor: 0, firstTime: false,
        split: [{ category: 'Electronics', amountMinor: 120000 }, { category: 'Home', amountMinor: 50000 }, { category: 'Merchandise & Supplies-Garden', amountMinor: 30000 }],
      },
      { id: 'row-2', merchant: 'SAMPLE TV', key: 'SAMPLE TV', amountMinor: 100000, date: '2026-10-06', category: 'Electronics', refundedMinor: 0, firstTime: false, split: [{ category: 'Electronics', amountMinor: 100000 }] },
      { id: 'row-3', merchant: 'SAMPLE DESK', key: 'SAMPLE DESK', amountMinor: 90000, date: '2026-10-07', category: 'Home', refundedMinor: 0, firstTime: false, split: [{ category: 'Home', amountMinor: 60000 }, { category: 'Office', amountMinor: 30000 }] },
    ],
  } }), thisMonth);
  assert.deepEqual(card.items.map((item) => item.note), ['Oct 5 · split: Electronics, Home and 1 more', 'Oct 6', 'Oct 7 · split: Home and Office']);
  // Under a category filter, a split purchase says its part in that category beside its whole amount.
  const [home] = buildInsightCards(findings({ largePurchases: {
    thresholdMinor: 80000, count: 1, totalMinor: 200000, share: 0.5, coreMinor: 200000, baselineCoreMinor: null,
    items: [{
      id: 'row-1', merchant: 'SAMPLE STORE', key: 'SAMPLE STORE', amountMinor: 200000, date: '2026-10-05', category: 'Electronics', refundedMinor: 0, firstTime: false,
      split: [{ category: 'Electronics', amountMinor: 120000 }, { category: 'Merchandise & Supplies-Home', amountMinor: 80000 }],
    }],
  } }), thisMonth, { category: 'Merchandise & Supplies-Home' });
  assert.deepEqual(home.items.map((item) => [item.amount, item.note]), [['$2,000.00', 'Oct 5 · split: Electronics and Home · $800.00 in Home']]);
  const [other] = buildInsightCards(findings({ largePurchases: {
    thresholdMinor: 80000, count: 1, totalMinor: 200000, share: 0.5, coreMinor: 200000, baselineCoreMinor: null,
    items: [{
      id: 'row-1', merchant: 'SAMPLE STORE', key: 'SAMPLE STORE', amountMinor: 200000, date: '2026-10-05', category: 'Electronics', refundedMinor: 0, firstTime: false,
      split: [{ category: 'Electronics', amountMinor: 120000 }, { category: 'Home', amountMinor: 80000 }],
    }],
  } }), thisMonth, { category: 'Dining' });
  assert.deepEqual(other.items.map((item) => item.note), ['Oct 5 · split: Electronics and Home']);
});