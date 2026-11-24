import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CardAccount } from '../types.js';
import type { IssuerBenefitTrackerRecord } from './issuerTrackers.js';
import { benefitCreditValue, computeCardBenefitsReport, matchBenefitCredit, type CardBenefitsReportInput } from './report.js';
import type { BenefitCatalog, BenefitCreditRow, BenefitProduct, CardBenefitMark, CardBenefitSettings } from './types.js';

/** A made-up product: every figure, name and pattern here is synthetic. */
const SAMPLE: BenefitProduct = {
  id: 'amex-sample-reserve',
  issuer: 'amex',
  name: 'Sample Reserve Card',
  shortName: 'Sample Reserve',
  nicknamePatterns: ['\\bsample\\s+reserve\\b'],
  annualFeeMinor: 40_000,
  sourceUrl: 'https://www.example.com/sample-reserve',
  benefits: [
    {
      id: 'stream', name: 'Streaming credit', kind: 'credit', value: { unit: 'usd', amountMinor: 1_500 },
      cadence: { every: 'month', basis: 'calendar' }, enrollment: true,
      tracking: { method: 'statement-credit', patterns: ['sample\\s*stream\\w*\\s+credit'] },
      validUntil: '2026-06-30',
    },
    {
      id: 'stream', name: 'Streaming credit', kind: 'credit', value: { unit: 'usd', amountMinor: 2_000 },
      cadence: { every: 'month', basis: 'calendar' }, enrollment: true,
      tracking: { method: 'statement-credit', patterns: ['sample\\s*stream\\w*\\s+credit'] },
      validFrom: '2026-07-01',
    },
    {
      id: 'boutique', name: 'Boutique credit', kind: 'credit', value: { unit: 'usd', amountMinor: 5_000 },
      cadence: { every: 'half', basis: 'calendar' }, enrollment: true,
      tracking: { method: 'statement-credit', patterns: ['\\bboutique\\b.*\\bcredit\\b'] },
    },
    {
      id: 'ride-cash', name: 'Ride cash', kind: 'credit', value: { unit: 'usd', amountMinor: 1_000, byStartMonth: { 12: 3_000 } },
      cadence: { every: 'month', basis: 'calendar' }, enrollment: false, tracking: { method: 'manual', reason: 'partner-balance' },
      issuerTrackerIds: ['ride.cash'],
    },
    {
      id: 'free-night', name: 'Free night', kind: 'certificate', value: { unit: 'count', count: 1, noun: 'free night' },
      compareAs: 'Sample hotel free night', category: 'hotel',
      cadence: { every: 'year', basis: 'cardmember' }, enrollment: false, tracking: { method: 'manual', reason: 'certificate' },
    },
    {
      id: 'trusted-traveler', name: 'Trusted traveler fee', kind: 'credit', value: { unit: 'usd', amountMinor: 12_000 },
      cadence: { every: 'years', months: 48 }, enrollment: false,
      tracking: { method: 'statement-credit', patterns: ['trusted\\s+traveler.*credit'] },
    },
  ],
};

const OTHER: BenefitProduct = {
  id: 'chase-sample-plus',
  issuer: 'chase',
  name: 'Sample Plus Card',
  shortName: 'Sample Plus',
  nicknamePatterns: ['\\bsample\\s+plus\\b'],
  annualFeeMinor: 9_500,
  sourceUrl: 'https://www.example.com/sample-plus',
  benefits: [
    {
      id: 'stay', name: 'Stay credit', kind: 'credit', value: { unit: 'usd', amountMinor: 5_000 },
      cadence: { every: 'year', basis: 'cardmember' }, enrollment: false,
      tracking: { method: 'statement-credit', patterns: ['\\bstay\\b.*\\bcredit\\b'] },
    },
  ],
};

const CATALOG: BenefitCatalog = { version: '2026.10.1', products: [SAMPLE, OTHER] };

function account(id: string, patch: Partial<CardAccount> = {}): CardAccount {
  return {
    id, issuer: 'amex', owner: 'alex', nickname: 'Sample Reserve', last4: '0001', currency: 'USD', status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...patch,
  };
}

let rowCount = 0;
function credit(cardAccountId: string, date: string, amountMinor: number, description: string, patch: Partial<BenefitCreditRow> = {}): BenefitCreditRow {
  rowCount += 1;
  return { id: `card-txn-${String(rowCount).padStart(3, '0')}`, cardAccountId, date, amountMinor, kind: 'adjustment', description, merchant: null, ...patch };
}

function report(patch: Partial<CardBenefitsReportInput> = {}) {
  return computeCardBenefitsReport({
    catalog: CATALOG, year: 2026, today: '2026-10-19', cards: [{ account: account('a1'), settings: null }],
    credits: [], marks: [], trackers: [], ...patch,
  });
}

const benefitOf = (result: ReturnType<typeof report>, card: string, id: string) =>
  result.cards.find((entry) => entry.cardAccountId === card)!.benefits.find((benefit) => benefit.id === id)!;

describe('benefit credit matching', () => {
  it('reads credits and credits taken back, never payments or purchases', () => {
    assert.equal(benefitCreditValue({ amountMinor: -1500, kind: 'adjustment' }), 1500);
    assert.equal(benefitCreditValue({ amountMinor: -1500, kind: 'refund' }), 1500);
    assert.equal(benefitCreditValue({ amountMinor: 1500, kind: 'adjustment' }), -1500);
    for (const row of [{ amountMinor: -1500, kind: 'payment' }, { amountMinor: 1500, kind: 'purchase' }, { amountMinor: 0, kind: 'other' }] as const) {
      assert.equal(benefitCreditValue(row), null, JSON.stringify(row));
    }
  });

  it('matches the description or the merchant against the version in force that day', () => {
    assert.equal(matchBenefitCredit(SAMPLE, credit('a1', '2026-03-02', -1500, 'SAMPLE STREAMING CREDIT')), 'stream');
    assert.equal(matchBenefitCredit(SAMPLE, credit('a1', '2026-03-02', -5000, 'ADJUSTMENT', { merchant: 'Boutique Credit' })), 'boutique');
    assert.equal(matchBenefitCredit(SAMPLE, credit('a1', '2026-03-02', -5000, 'SAMPLE BOUTIQUE', { kind: 'refund' })), null);
    assert.equal(matchBenefitCredit(SAMPLE, credit('a1', '2026-03-02', -1500, 'SAMPLE STREAMING CREDIT', { kind: 'payment' })), null);
  });
});

describe('the benefits report', () => {
  it('derives each period from matched credits, capped at the period amount, with the version of that period', () => {
    const result = report({
      credits: [
        credit('a1', '2026-02-03', -1500, 'SAMPLE STREAMING CREDIT'),
        credit('a1', '2026-02-20', -1500, 'SAMPLE STREAMING CREDIT'),
        credit('a1', '2026-08-04', -2000, 'SAMPLE STREAMING CREDIT'),
        credit('a1', '2026-08-25', 2000, 'SAMPLE STREAMING CREDIT REVERSAL'),
        credit('a1', '2026-09-08', -1200, 'SAMPLE STREAMING CREDIT'),
        credit('a1', '2026-09-09', -900, 'SAMPLE STREAMING', { kind: 'refund' }),
        credit('a1', '2026-09-10', -1500, 'SAMPLE STREAMING CREDIT', { kind: 'payment' }),
      ],
    });
    const stream = benefitOf(result, 'a1', 'stream');
    const byLabel = Object.fromEntries(stream.periods.map((period) => [period.label, period]));
    assert.equal(byLabel.Feb.availableMinor, 1500);
    assert.equal(byLabel.Feb.usedMinor, 1500);
    assert.deepEqual(byLabel.Feb.matches.map((match) => match.date), ['2026-02-20']);
    // Early February's credit moved back to January, which had room.
    assert.equal(byLabel.Jan.usedMinor, 1500);
    assert.deepEqual(byLabel.Jan.matches.map((match) => match.date), ['2026-02-03']);
    assert.equal(byLabel.Aug.availableMinor, 2000);
    assert.equal(byLabel.Aug.usedMinor, 0);
    assert.equal(byLabel.Sep.usedMinor, 1200);
    assert.equal(byLabel.Sep.source, 'derived');
    assert.equal(stream.year.availableMinor, 6 * 1500 + 6 * 2000);
    assert.equal(stream.year.capturedMinor, 1500 + 1500 + 1200);
    assert.equal(stream.unit, 'usd');
    assert.equal(stream.enrollment, true);
  });

  it('keeps a credit in its own period when the period before is already full', () => {
    const result = report({
      credits: [
        credit('a1', '2026-01-15', -1500, 'SAMPLE STREAMING CREDIT'),
        credit('a1', '2026-02-02', -1500, 'SAMPLE STREAMING CREDIT'),
        credit('a1', '2026-02-27', -1500, 'SAMPLE STREAMING CREDIT'),
      ],
    });
    const periods = benefitOf(result, 'a1', 'stream').periods;
    assert.deepEqual(periods.slice(0, 2).map((period) => [period.usedMinor, period.matches.length]), [[1500, 1], [1500, 2]]);
  });

  it('prefers the issuer figure, then the owner\'s mark, then matched credits', () => {
    const marks: CardBenefitMark[] = [
      { cardAccountId: 'a1', benefitId: 'boutique', periodStart: '2026-01-01', status: 'partial', usedMinor: 2000, markedAt: '2026-05-01T00:00:00.000Z' },
      { cardAccountId: 'a1', benefitId: 'boutique', periodStart: '2026-07-01', status: 'unused', usedMinor: null, markedAt: '2026-10-01T00:00:00.000Z' },
      { cardAccountId: 'a1', benefitId: 'ride-cash', periodStart: '2026-09-01', status: 'used', usedMinor: null, markedAt: '2026-09-30T00:00:00.000Z' },
    ];
    const trackers: IssuerBenefitTrackerRecord[] = [{
      cardAccountId: 'a1', issuer: 'amex', issuerBenefitId: 'ride.cash', name: 'Ride Cash', periodStart: '2026-10-01',
      periodEnd: '2026-10-31', unit: 'money', currency: 'USD', usedMinor: 400, totalMinor: 1000, resetDate: '2026-11-01',
      enrollment: 'not-required', observedAt: '2026-10-18T12:00:00.000Z', recordedAt: '2026-10-18T12:00:01.000Z',
    }];
    const result = report({
      marks, trackers,
      credits: [credit('a1', '2026-08-10', -5000, 'SAMPLE BOUTIQUE CREDIT'), credit('a1', '2026-03-10', -5000, 'SAMPLE BOUTIQUE CREDIT')],
    });
    const boutique = benefitOf(result, 'a1', 'boutique');
    assert.deepEqual(boutique.periods.map((period) => [period.source, period.usedMinor, period.derivedMinor]), [['manual', 2000, 5000], ['manual', 0, 5000]]);
    const ride = benefitOf(result, 'a1', 'ride-cash');
    const sep = ride.periods[8];
    const oct = ride.periods[9];
    assert.deepEqual([sep.source, sep.usedMinor], ['manual', 1000]);
    assert.deepEqual([oct.source, oct.usedMinor, oct.availableMinor, oct.issuer?.stale], ['issuer', 400, 1000, false]);
    assert.deepEqual([ride.periods[10].source, ride.periods[10].usedMinor], ['none', null]);
    assert.equal(ride.periods[11].availableMinor, 3000);
    // Unknown past and current months (all but September and October) are counted, future ones are not.
    assert.equal(ride.year.unknownPeriods, 8);
    assert.equal(ride.current?.remainingMinor, 600);
    assert.equal(ride.current?.source, 'issuer');
  });

  it('ignores an issuer figure in another unit or currency, and marks an old one stale', () => {
    const tracker = (patch: Partial<IssuerBenefitTrackerRecord>): IssuerBenefitTrackerRecord => ({
      cardAccountId: 'a1', issuer: 'amex', issuerBenefitId: 'ride.cash', name: 'Ride Cash', periodStart: '2026-10-01',
      periodEnd: '2026-10-31', unit: 'money', currency: 'USD', usedMinor: 1000, totalMinor: 1000, resetDate: null,
      enrollment: 'unknown', observedAt: '2026-10-01T12:00:00.000Z', recordedAt: '2026-10-01T12:00:01.000Z', ...patch,
    });
    const oct = (trackers: IssuerBenefitTrackerRecord[]) => benefitOf(report({ trackers }), 'a1', 'ride-cash').periods[9];
    assert.deepEqual([oct([tracker({ currency: 'EUR' })]).source, oct([tracker({ unit: 'count', currency: null })]).source], ['none', 'none']);
    // An issuer that reports the use as unknown keeps it unknown: no mark or matched credit fills it in.
    const unknown = (marks: CardBenefitMark[]) => benefitOf(report({ trackers: [tracker({ usedMinor: null })], marks }), 'a1', 'ride-cash');
    assert.deepEqual([oct([tracker({ usedMinor: null })]).source, oct([tracker({ usedMinor: null })]).usedMinor], ['issuer', null]);
    const marked = unknown([{ cardAccountId: 'a1', benefitId: 'ride-cash', periodStart: '2026-10-01', status: 'used', usedMinor: null, markedAt: '2026-10-02T00:00:00.000Z' }]);
    assert.deepEqual([marked.periods[9].source, marked.periods[9].usedMinor, marked.current?.remainingMinor], ['issuer', null, null]);
    assert.equal(oct([tracker({})]).issuer?.stale, true);
    // The latest observation of a period wins.
    assert.equal(oct([tracker({ usedMinor: 200, observedAt: '2026-10-18T00:00:00.000Z' }), tracker({ usedMinor: 900 })]).usedMinor, 200);
  });

  it('lists issuer trackers no benefit maps on their card', () => {
    const result = report({
      trackers: [{
        cardAccountId: 'a1', issuer: 'amex', issuerBenefitId: 'unmapped.tracker', name: 'Sample Perk', periodStart: '2026-01-01',
        periodEnd: '2026-12-31', unit: 'count', currency: null, usedMinor: 0, totalMinor: 2, resetDate: null,
        enrollment: 'enrolled', observedAt: '2026-10-19T08:00:00.000Z', recordedAt: '2026-10-19T08:00:00.000Z',
      }],
    });
    assert.deepEqual(result.cards[0].issuerTrackers.map((tracker) => [tracker.issuerBenefitId, tracker.totalMinor]), [['unmapped.tracker', 2]]);
  });

  it('keeps each card\'s own issuer observations when two cards report the same tracker', () => {
    const tracker = (cardAccountId: string, issuerBenefitId: string, usedMinor: number): IssuerBenefitTrackerRecord => ({
      cardAccountId, issuer: 'amex', issuerBenefitId, name: 'Sample Tracker', periodStart: '2026-10-01', periodEnd: '2026-10-31',
      unit: 'money', currency: 'USD', usedMinor, totalMinor: 1000, resetDate: null, enrollment: 'enrolled',
      observedAt: cardAccountId === 'a1' ? '2026-10-19T08:00:00.000Z' : '2026-10-19T09:00:00.000Z', recordedAt: '2026-10-19T09:00:00.000Z',
    });
    const result = report({
      cards: [{ account: account('a1'), settings: null }, { account: account('a2', { owner: 'casey' }), settings: null }],
      trackers: [tracker('a1', 'ride.cash', 300), tracker('a2', 'ride.cash', 700), tracker('a1', 'other.perk', 1), tracker('a2', 'other.perk', 2)],
    });
    assert.deepEqual(result.cards.map((card) => card.benefits.find((benefit) => benefit.id === 'ride-cash')!.periods[9].usedMinor), [300, 700]);
    assert.deepEqual(result.cards.map((card) => card.issuerTrackers.map((entry) => entry.usedMinor)), [[1], [2]]);
  });

  it('needs the anniversary month for cardmember-year benefits, and places them once it is known', () => {
    const before = benefitOf(report(), 'a1', 'free-night');
    assert.deepEqual([before.needsAnniversary, before.periods.length, before.current], [true, 0, null]);
    assert.equal(report().cards[0].needsAnniversary, true);
    const settings: CardBenefitSettings = {
      cardAccountId: 'a1', productChoice: 'auto', productId: null, anniversaryMonth: 11, updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const placed = report({
      cards: [{ account: account('a1'), settings }],
      marks: [{ cardAccountId: 'a1', benefitId: 'free-night', periodStart: '2025-11-01', status: 'used', usedMinor: null, markedAt: '2026-02-01T00:00:00.000Z' }],
    });
    const night = benefitOf(placed, 'a1', 'free-night');
    assert.deepEqual(night.periods.map((period) => [period.label, period.state]), [['Nov 2026 – Oct 2027', 'future']]);
    // Today's cardmember year began in November 2025: it ends in 13 days and the night was used.
    assert.deepEqual([night.current?.start, night.current?.daysLeft, night.current?.usedMinor, night.current?.resetsSoon], ['2025-11-01', 13, 1, false]);
    assert.equal(night.inTotals, false);
  });

  it('passes on a benefit\'s comparison name and category, and only when the catalog gives them', () => {
    const result = report();
    assert.equal(benefitOf(result, 'a1', 'free-night').compareAs, 'Sample hotel free night');
    assert.equal(benefitOf(result, 'a1', 'free-night').category, 'hotel');
    assert.equal('compareAs' in benefitOf(result, 'a1', 'stream'), false);
    assert.equal('category' in benefitOf(result, 'a1', 'stream'), false);
  });

  it('reminds about current periods that end soon with something left, soonest first', () => {
    const result = report({
      today: '2026-12-27',
      credits: [credit('a1', '2026-12-05', -2000, 'SAMPLE STREAMING CREDIT'), credit('a1', '2026-11-05', -5000, 'SAMPLE BOUTIQUE CREDIT')],
    });
    assert.deepEqual(result.resetsSoon.map((reminder) => [reminder.benefitId, reminder.daysLeft, reminder.remainingMinor]), [
      ['ride-cash', 5, null],
    ]);
    // The streaming and boutique credits are used up, so they are not reminders.
    assert.equal(result.resetsSoon.some((reminder) => reminder.benefitId === 'stream' || reminder.benefitId === 'boutique'), false);
  });

  it('tracks a once-every-few-years credit by its last use, outside the totals', () => {
    const result = report({ credits: [credit('a1', '2024-05-06', -12_000, 'SAMPLE TRUSTED TRAVELER FEE CREDIT')] });
    const traveler = benefitOf(result, 'a1', 'trusted-traveler');
    assert.deepEqual(traveler.window, { lastUsed: '2024-05-06', nextEligible: '2028-05-06' });
    assert.deepEqual([traveler.inTotals, traveler.current, traveler.periods[0].usedMinor], [false, null, 0]);
    const used2026 = benefitOf(report({ credits: [credit('a1', '2026-04-01', -12_000, 'SAMPLE TRUSTED TRAVELER FEE CREDIT')] }), 'a1', 'trusted-traveler');
    assert.equal(used2026.periods[0].usedMinor, 12_000);
    const old = benefitOf(report({ credits: [credit('a1', '2021-04-01', -12_000, 'SAMPLE TRUSTED TRAVELER FEE CREDIT')] }), 'a1', 'trusted-traveler');
    assert.deepEqual(old.window, { lastUsed: null, nextEligible: null });
  });

  it('counts only an effective use toward the once-every-few-years window', () => {
    const window = (patch: Partial<CardBenefitsReportInput>) => benefitOf(report(patch), 'a1', 'trusted-traveler').window;
    const fee = credit('a1', '2025-05-06', -12_000, 'SAMPLE TRUSTED TRAVELER FEE CREDIT');
    const mark = (status: CardBenefitMark['status'], usedMinor: number | null = null): CardBenefitMark => ({
      cardAccountId: 'a1', benefitId: 'trusted-traveler', periodStart: '2025-01-01', status, usedMinor, markedAt: '2025-06-01T00:00:00.000Z',
    });
    // The owner said the matched credit was no use of it, or a reversal took it back: still available.
    assert.deepEqual(window({ credits: [fee], marks: [mark('unused')] }), { lastUsed: null, nextEligible: null });
    assert.deepEqual(window({ credits: [fee, credit('a1', '2025-05-20', 12_000, 'SAMPLE TRUSTED TRAVELER FEE CREDIT REVERSAL')] }),
      { lastUsed: null, nextEligible: null });
    // A zero amount is no use; a marked use without a credit dates from the day it was marked.
    assert.deepEqual(window({ marks: [mark('partial', 0)] }), { lastUsed: null, nextEligible: null });
    assert.deepEqual(window({ marks: [mark('used')] }), { lastUsed: '2025-06-01', nextEligible: '2029-06-01' });
    assert.deepEqual(window({ credits: [fee] }), { lastUsed: '2025-05-06', nextEligible: '2029-05-06' });
    // Confirming a use the credit already dates, by a mark or an issuer figure, keeps the credit's date.
    assert.deepEqual(window({ credits: [fee], marks: [mark('used')] }), { lastUsed: '2025-05-06', nextEligible: '2029-05-06' });
    const traveler = (patch: Partial<IssuerBenefitTrackerRecord>): IssuerBenefitTrackerRecord => ({
      cardAccountId: 'a1', issuer: 'amex', issuerBenefitId: 'traveler.fee', name: 'Sample Traveler Fee', periodStart: '2025-01-01',
      periodEnd: '2025-12-31', unit: 'money', currency: 'USD', usedMinor: 12_000, totalMinor: 12_000, resetDate: null,
      enrollment: 'not-required', observedAt: '2025-11-02T00:00:00.000Z', recordedAt: '2025-11-02T00:00:00.000Z', ...patch,
    });
    const withIssuer = (trackers: IssuerBenefitTrackerRecord[], credits: BenefitCreditRow[]) => benefitOf(report({
      catalog: { ...CATALOG, products: [{ ...SAMPLE, benefits: SAMPLE.benefits.map((benefit) => (benefit.id === 'trusted-traveler'
        ? { ...benefit, issuerTrackerIds: ['traveler.fee'] } : benefit)) }, OTHER] },
      trackers, credits,
    }), 'a1', 'trusted-traveler').window;
    assert.deepEqual(withIssuer([traveler({})], [fee]), { lastUsed: '2025-05-06', nextEligible: '2029-05-06' });
    assert.deepEqual(withIssuer([traveler({})], []), { lastUsed: '2025-11-02', nextEligible: '2029-11-02' });
    assert.deepEqual(withIssuer([traveler({ usedMinor: 0 })], [fee]), { lastUsed: null, nextEligible: null });
  });

  it('adds up active cards per owner and for the household, against annual fees', () => {
    const result = report({
      cards: [
        { account: account('a1'), settings: null },
        { account: account('a2', { owner: 'casey', issuer: 'chase', nickname: 'Sample Plus' }), settings: null },
        { account: account('a3', { status: 'closed' }), settings: null },
        { account: account('a4', { nickname: 'Unknown Card' }), settings: null },
      ],
      credits: [credit('a1', '2026-03-03', -5000, 'SAMPLE BOUTIQUE CREDIT'), credit('a3', '2026-03-03', -5000, 'SAMPLE BOUTIQUE CREDIT')],
    });
    const a1 = result.cards[0].totals;
    // Streaming (6 × $15 + 6 × $20), boutique (2 × $50), ride cash (11 × $10 + $30); certificates and the fee credit excluded.
    assert.deepEqual(a1, { capturedMinor: 5000, availableMinor: 21_000 + 10_000 + 14_000, annualFeesMinor: 40_000 });
    assert.deepEqual(result.household.byOwner.casey, { capturedMinor: 0, availableMinor: 0, annualFeesMinor: 9_500 });
    assert.deepEqual(result.household.byOwner.joint, { capturedMinor: 0, availableMinor: 0, annualFeesMinor: 0 });
    assert.deepEqual(
      [result.household.capturedMinor, result.household.availableMinor, result.household.annualFeesMinor],
      [5000, 45_000, 49_500],
    );
    assert.equal(result.cards[2].totals.capturedMinor, 5000);
    assert.deepEqual([result.cards[3].product, result.cards[3].productSource, result.cards[3].benefits], [null, 'none', []]);
    assert.deepEqual(result.products.map((product) => product.id), ['amex-sample-reserve', 'chase-sample-plus']);
  });

  it('follows the owner\'s product choice over the nickname, and reports a choice the catalog lost', () => {
    const settings = (patch: Partial<CardBenefitSettings>): CardBenefitSettings => ({
      cardAccountId: 'a1', productChoice: 'auto', productId: null, anniversaryMonth: null, updatedAt: '2026-01-01T00:00:00.000Z', ...patch,
    });
    const card = (value: CardBenefitSettings, nickname = 'Renamed') => report({ cards: [{ account: account('a1', { nickname }), settings: value }] }).cards[0];
    assert.deepEqual([card(settings({ productChoice: 'manual', productId: 'amex-sample-reserve' })).product?.id, card(settings({ productChoice: 'manual', productId: 'amex-sample-reserve' })).productSource], ['amex-sample-reserve', 'manual']);
    assert.equal(card(settings({ productChoice: 'manual', productId: 'amex-retired-card' })).productSource, 'missing');
    assert.equal(card(settings({ productChoice: 'manual', productId: 'chase-sample-plus' })).productSource, 'missing');
    assert.equal(card(settings({ productChoice: 'none' }), 'Sample Reserve').productSource, 'none');
    assert.equal(card(settings({}), 'Sample Reserve').productSource, 'auto');
  });

  it('omits a benefit in years it did not exist, and leaves non-USD cards underived', () => {
    const before = report({ year: 2024 });
    assert.equal(benefitOf(before, 'a1', 'stream').periods.every((period) => period.active), true);
    const euro = report({
      cards: [{ account: account('a1', { currency: 'EUR' }), settings: null }],
      credits: [credit('a1', '2026-03-03', -5000, 'SAMPLE BOUTIQUE CREDIT')],
    });
    assert.equal(benefitOf(euro, 'a1', 'boutique').periods[0].usedMinor, 0);
  });
});
