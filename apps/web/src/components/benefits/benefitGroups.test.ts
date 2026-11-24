import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BENEFITS_CATALOG,
  computeCardBenefitsReport,
  type BenefitCreditRow,
  type BenefitIssuerFigure,
  type BenefitProduct,
  type BenefitTracking,
  type BenefitView,
  type CardAccount,
  type CardBenefitSettings,
  type CardBenefitsCardView,
} from '@finance-tracker/shared';

import {
  BENEFIT_SECTIONS,
  benefitGroupKey,
  benefitTags,
  benefitTerms,
  groupCardsByBenefit,
  groupTags,
  groupYearNotes,
  isComparedCard,
  issuerTrackerGroups,
  missingByOwner,
  missingProductLabel,
  normalizeBenefitName,
  sectionYear,
  type BenefitGroup,
} from './benefitGroups';
import { unknownUseOf } from './benefitsFormat';

// Everything below is made up: products, names, patterns, amounts, nicknames and card endings.

const MONTHLY = { every: 'month', basis: 'calendar' } as const;
const QUARTERLY = { every: 'quarter', basis: 'calendar' } as const;
const HALF_YEARLY = { every: 'half', basis: 'calendar' } as const;
const CALENDAR_YEAR = { every: 'year', basis: 'calendar' } as const;
const CARDMEMBER_YEAR = { every: 'year', basis: 'cardmember' } as const;
const EVERY_FOUR_YEARS = { every: 'years', months: 48 } as const;
const credit = (pattern: string): BenefitTracking => ({ method: 'statement-credit', patterns: [pattern] });
const usd = (amountMinor: number) => ({ unit: 'usd' as const, amountMinor });
const night = { unit: 'count' as const, count: 1, noun: 'free night' };

const BUSINESS: BenefitProduct = {
  id: 'amex-sample-business', issuer: 'amex', name: 'Sample Business Card', shortName: 'Sample Business',
  nicknamePatterns: ['\\bsample\\s+business\\b'], annualFeeMinor: 50_000, sourceUrl: 'https://www.example.com/business',
  benefits: [
    { id: 'hotel', name: 'Hotel credit (Sample Collection)', kind: 'credit', category: 'hotel', value: usd(30_000), cadence: HALF_YEARLY, enrollment: false,
      tracking: credit('sample\\s+hotel\\s+credit') },
    { id: 'software', name: 'Software credit', kind: 'credit', category: 'business', value: usd(25_000), cadence: CALENDAR_YEAR, enrollment: true,
      tracking: credit('sample\\s+software\\s+credit') },
    { id: 'phone', name: 'Phone credit', kind: 'credit', category: 'business', value: usd(1_000), cadence: MONTHLY, enrollment: true,
      tracking: credit('sample\\s+phone\\s+credit'), verify: true },
    { id: 'trusted-traveler', name: 'Trusted traveler fee', kind: 'credit', category: 'travel', value: usd(12_000), cadence: EVERY_FOUR_YEARS,
      enrollment: false, tracking: credit('sample\\s+traveler\\s+credit') },
  ],
};

const PERSONAL: BenefitProduct = {
  id: 'amex-sample-personal', issuer: 'amex', name: 'Sample Personal Card', shortName: 'Sample Personal',
  nicknamePatterns: ['\\bsample\\s+personal\\b'], annualFeeMinor: 25_000, sourceUrl: 'https://www.example.com/personal',
  benefits: [
    { id: 'hotel-stay', name: 'Hotel Credit — Sample Collection™', kind: 'credit', category: 'hotel', value: usd(30_000), cadence: HALF_YEARLY,
      enrollment: true, tracking: credit('sample\\s+stay\\s+credit') },
    { id: 'diner', name: 'Diner’s credit', kind: 'credit', category: 'dining', value: usd(1_500), cadence: QUARTERLY, enrollment: false,
      tracking: credit('sample\\s+diner\\s+credit') },
    { id: 'ride-cash', name: 'Ride cash', kind: 'credit', category: 'travel', value: { unit: 'usd', amountMinor: 1_000, byStartMonth: { 12: 3_000 } },
      cadence: MONTHLY, enrollment: false, tracking: { method: 'manual', reason: 'partner-balance' } },
    { id: 'free-night', name: 'Free night award', kind: 'certificate', category: 'hotel', value: night, cadence: CARDMEMBER_YEAR, enrollment: false,
      tracking: { method: 'manual', reason: 'certificate' } },
    { id: 'traveler', name: 'Trusted Traveler Fee', kind: 'credit', category: 'travel', value: usd(10_000), cadence: EVERY_FOUR_YEARS, enrollment: false,
      tracking: credit('sample\\s+traveler\\s+credit') },
  ],
};

const TRAVEL: BenefitProduct = {
  id: 'chase-sample-travel', issuer: 'chase', name: 'Sample Travel Card', shortName: 'Sample Travel',
  nicknamePatterns: ['\\bsample\\s+travel\\b'], annualFeeMinor: 9_500, sourceUrl: 'https://www.example.com/travel',
  benefits: [
    { id: 'dining', name: 'Diner\'s Credit', kind: 'credit', category: 'dining', value: usd(2_500), cadence: MONTHLY, enrollment: true,
      tracking: { method: 'manual', reason: 'not-itemized' } },
    { id: 'night', name: 'Free Night Award', kind: 'certificate', category: 'hotel', value: night, cadence: CARDMEMBER_YEAR, enrollment: false,
      tracking: { method: 'manual', reason: 'certificate' } },
    // A dollar credit that shares a counted benefit's name: never the same group.
    { id: 'night-credit', name: 'Free night award', kind: 'credit', value: usd(5_000), cadence: CALENDAR_YEAR, enrollment: false,
      tracking: { method: 'manual', reason: 'not-itemized' } },
  ],
};

const BASIC: BenefitProduct = {
  id: 'citi-sample-basic', issuer: 'citi', name: 'Sample Basic Card', shortName: 'Sample Basic',
  nicknamePatterns: ['\\bsample\\s+basic\\b'], annualFeeMinor: null, sourceUrl: 'https://www.example.com/basic', benefits: [],
};

function account(id: string, patch: Partial<CardAccount>): CardAccount {
  return {
    id, issuer: 'amex', owner: 'alex', currency: 'USD', status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...patch,
  };
}

function settings(cardAccountId: string, patch: Partial<CardBenefitSettings>): CardBenefitSettings {
  return { cardAccountId, productChoice: 'auto', productId: null, anniversaryMonth: null, updatedAt: '2026-01-01T00:00:00.000Z', ...patch };
}

const TODAY = '2026-10-27';

const CARDS = [
  { account: account('card-a', { owner: 'alex', nickname: 'Sample Business', last4: '0001', last5: '90001' }), settings: null },
  { account: account('card-b', { owner: 'casey', nickname: 'Sample Business', last4: '0002', last5: '90002' }), settings: null },
  { account: account('card-c', { owner: 'alex', nickname: 'Sample Personal', last4: '0003', last5: '90003' }), settings: null },
  {
    account: account('card-d', { issuer: 'chase', owner: 'joint', nickname: 'Sample Travel', last4: '0004' }),
    settings: settings('card-d', { anniversaryMonth: 3 }),
  },
  { account: account('card-e', { issuer: 'citi', owner: 'alex', nickname: 'Sample Basic', last4: '0005' }), settings: null },
  { account: account('card-f', { owner: 'casey', nickname: 'Mystery', last4: '0006', last5: '90006' }), settings: null },
  {
    account: account('card-g', { owner: 'joint', nickname: 'Sample Spare', last4: '0007', last5: '90007' }),
    settings: settings('card-g', { productChoice: 'none' }),
  },
  {
    account: account('card-h', { owner: 'alex', nickname: 'Sample Business', last4: '0008', last5: '90008', status: 'closed' }),
    settings: null,
  },
];

const CREDITS: BenefitCreditRow[] = [
  { id: 'row-1', cardAccountId: 'card-a', date: '2026-03-10', amountMinor: -30_000, kind: 'adjustment', description: 'SAMPLE HOTEL CREDIT', merchant: null },
  { id: 'row-2', cardAccountId: 'card-c', date: '2026-02-02', amountMinor: -1_500, kind: 'adjustment', description: 'SAMPLE DINER CREDIT', merchant: null },
];

function reportWith(credits: readonly BenefitCreditRow[]) {
  return computeCardBenefitsReport({
    catalog: { version: '2026.10.2', products: [BUSINESS, PERSONAL, TRAVEL, BASIC] },
    year: 2026,
    today: TODAY,
    cards: CARDS,
    credits,
    marks: [],
    trackers: [],
  });
}

const REPORT = reportWith(CREDITS);
const ACTIVE = REPORT.cards.filter((card) => card.status === 'active');
const GROUPING = groupCardsByBenefit(ACTIVE, TODAY);

const ids = (cards: readonly Pick<CardBenefitsCardView, 'cardAccountId'>[]) => cards.map((card) => card.cardAccountId);
const memberIds = (group: BenefitGroup) => group.members.map(({ card, benefit }) => `${card.cardAccountId}/${benefit.id}`);
const tagLabels = (tags: readonly { label: string }[]) => tags.map((tag) => tag.label);

function groupNamed(name: string, kind?: BenefitGroup['kind'], groups: readonly BenefitGroup[] = GROUPING.groups): BenefitGroup {
  const group = groups.find((entry) => entry.name === name && (kind === undefined || entry.kind === kind));
  assert.ok(group, `no group named ${name}`);
  return group;
}

/** The cards with one benefit of one card changed. */
function withBenefit(cardAccountId: string, benefitId: string, patch: Partial<BenefitView>): CardBenefitsCardView[] {
  return ACTIVE.map((card) => (card.cardAccountId !== cardAccountId ? card : {
    ...card,
    benefits: card.benefits.map((benefit) => (benefit.id === benefitId ? { ...benefit, ...patch } : benefit)),
  }));
}

test('benefit names are compared without case, punctuation, apostrophe or dash variants, trademark signs or accents', () => {
  const same = ['Dunkin’ credit', 'Dunkin\' credit', 'DUNKIN credit', '  Dunkin®   credit ', 'Dunkin\u02BC credit'];
  for (const name of same) assert.equal(normalizeBenefitName(name), 'dunkin credit', name);
  assert.equal(normalizeBenefitName('Hotel credit (FHR / The Hotel Collection)'), 'hotel credit fhr the hotel collection');
  assert.equal(normalizeBenefitName('Hotel Credit — Sample Collection™'), normalizeBenefitName('Hotel credit (Sample Collection)'));
  assert.equal(normalizeBenefitName('Wi-Fi credit'), normalizeBenefitName('WiFi credit'));
  assert.equal(normalizeBenefitName('Fine Hotels & Resorts credit'), normalizeBenefitName('Fine Hotels and Resorts credit'));
  assert.equal(normalizeBenefitName('Crème brûlée credit'), normalizeBenefitName('Creme brulee credit'));
  assert.equal(normalizeBenefitName('Ｓａｍｐｌｅ credit'), 'sample credit');
  // What tells benefits apart stays: a "+", an amount, a qualifier.
  assert.notEqual(normalizeBenefitName('Walmart+ credit'), normalizeBenefitName('Walmart credit'));
  assert.notEqual(normalizeBenefitName('$125 flight discount'), normalizeBenefitName('$100 flight discount'));
  assert.notEqual(normalizeBenefitName('Hotel credit'), normalizeBenefitName('Hotel credit (until Sept 2025)'));
});

test('a group key keeps dollar credits, counted benefits and once-every-few-years credits apart', () => {
  const name = 'Free night award';
  const dollars = benefitGroupKey({ name, unit: 'usd', inTotals: true });
  const nights = benefitGroupKey({ name, unit: 'count', noun: 'free night', inTotals: false });
  const certificates = benefitGroupKey({ name, unit: 'count', noun: 'certificate', inTotals: false });
  const window = benefitGroupKey({ name, unit: 'usd', inTotals: false });
  assert.equal(new Set([dollars, nights, certificates, window]).size, 4);
  assert.equal(benefitGroupKey({ name: 'FREE NIGHT AWARD', unit: 'count', noun: 'Free Night', inTotals: false }), nights);
});

test('the same benefit on two cards of one product is one group, and same-named benefits of other products join it', () => {
  const hotel = groupNamed('Hotel credit (Sample Collection)');
  // Card order: Amex before Chase and Citi, Alex before Casey and Joint, then the report's order.
  assert.deepEqual(memberIds(hotel), ['card-a/hotel', 'card-c/hotel-stay', 'card-b/hotel']);
  assert.equal(hotel.cardCount, 3);
  assert.equal(hotel.kind, 'credit');
  assert.deepEqual(hotel.year, { capturedMinor: 30_000, availableMinor: 180_000, unknownPeriods: 0 });
  // Each card keeps its own figures: the report's, untouched.
  const [a, c, b] = hotel.members;
  assert.equal(a.benefit, ACTIVE.find((card) => card.cardAccountId === 'card-a')!.benefits.find((entry) => entry.id === 'hotel'));
  assert.deepEqual(a.benefit.periods.map((period) => [period.label, period.usedMinor, period.availableMinor]), [['Jan–Jun', 30_000, 30_000], ['Jul–Dec', 0, 30_000]]);
  assert.deepEqual(b.benefit.periods.map((period) => period.usedMinor), [0, 0]);
  assert.equal(c.benefit.current?.remainingMinor, 30_000);
  // Said once for the group: the terms all three share. The one card that needs enrolling says so itself.
  assert.deepEqual(tagLabels(hotel.sharedTags), ['$300 · Twice a year']);
  assert.deepEqual(tagLabels(benefitTags(c.benefit)), ['$300 · Twice a year', 'Enrollment required']);

  const software = groupNamed('Software credit');
  assert.deepEqual(memberIds(software), ['card-a/software', 'card-b/software']);
  assert.deepEqual(tagLabels(software.sharedTags), ['$250 · Each calendar year', 'Enrollment required']);
  assert.deepEqual(tagLabels(groupNamed('Phone credit').sharedTags), ['$10 · Monthly', 'Enrollment required', 'Unverified']);
});

test('one benefit of one product stays one group whatever a version calls it', () => {
  const { groups } = groupCardsByBenefit(withBenefit('card-b', 'software', { name: 'Software and services credit' }), TODAY);
  const software = groups.filter((group) => group.members.some(({ benefit }) => benefit.id === 'software'));
  assert.equal(software.length, 1);
  assert.equal(software[0].name, 'Software credit');
  assert.deepEqual(memberIds(software[0]), ['card-a/software', 'card-b/software']);
});

test('the catalog\'s comparison name keeps apart same-named benefits of different programs, and joins renamed ones', () => {
  // Apart: one card's stay credit is its own program's.
  const apart = groupCardsByBenefit(withBenefit('card-c', 'hotel-stay', { compareAs: 'Sample stay credit' }), TODAY).groups;
  assert.deepEqual(memberIds(groupNamed('Hotel credit (Sample Collection)', 'credit', apart)), ['card-a/hotel', 'card-b/hotel']);
  assert.deepEqual(memberIds(groupNamed('Sample stay credit', 'credit', apart)), ['card-c/hotel-stay']);
  // Together: a night named otherwise, compared as the free night it is.
  const together = groupCardsByBenefit(withBenefit('card-d', 'night', { name: 'Anniversary night', compareAs: 'Free night award' }), TODAY).groups;
  assert.deepEqual(memberIds(groupNamed('Free night award', 'count', together)), ['card-c/free-night', 'card-d/night']);
  assert.equal(benefitGroupKey({ name: 'Anniversary night', compareAs: 'FREE NIGHT AWARD', unit: 'count', noun: 'free night', inTotals: false }),
    benefitGroupKey({ name: 'Free night award', unit: 'count', noun: 'free night', inTotals: false }));
});

test('a benefit offered by period types that differ is one group, each card with its own periods and terms', () => {
  const diner = groupNamed('Diner’s credit');
  assert.deepEqual(memberIds(diner), ['card-c/diner', 'card-d/dining']);
  assert.deepEqual(diner.members.map(({ benefit }) => benefit.periods.length), [4, 12]);
  assert.deepEqual(diner.sharedTags, []);
  assert.deepEqual(diner.members.map(({ benefit }) => tagLabels(benefitTags(benefit))), [
    ['$15 · Quarterly'],
    ['$25 · Monthly', 'Enrollment required', 'Mark by hand'],
  ]);
  // A quarter's credit was matched; the monthly one is marked by hand and nothing is marked yet: Jan–Oct are unknown.
  assert.deepEqual(diner.year, { capturedMinor: 1_500, availableMinor: 6_000 + 30_000, unknownPeriods: 10 });
  // The group says so, rather than reading the unknown months as unused.
  assert.deepEqual(groupYearNotes(diner), ['10 periods with use unknown']);
  assert.deepEqual(groupYearNotes(groupNamed('Hotel credit (Sample Collection)')), []);

  // Periods that give different amounts say only how often; so does a benefit not placed in its year yet.
  const ride = groupNamed('Ride cash');
  assert.deepEqual(tagLabels(ride.sharedTags), ['Monthly', 'Mark by hand']);
  assert.equal(benefitTerms(ride.members[0].benefit), 'Monthly');

  const nights = groupNamed('Free night award', 'count');
  assert.deepEqual(memberIds(nights), ['card-c/free-night', 'card-d/night']);
  assert.deepEqual(nights.members.map(({ benefit }) => [benefit.needsAnniversary, benefit.periods.length]), [[true, 0], [false, 1]]);
  assert.deepEqual(nights.members.map(({ benefit }) => benefitTerms(benefit)), ['Each cardmember year', '1 free night · Each cardmember year']);
  // How often is the same on both: said once, for the group; only one card's night has an amount to say.
  assert.deepEqual(tagLabels(nights.sharedTags), ['Each cardmember year', 'Mark by hand']);
  assert.deepEqual(nights.year, { capturedMinor: 0, availableMinor: 1, unknownPeriods: 1 });
  assert.equal(nights.unplaced, 1);
  assert.deepEqual(groupYearNotes(nights), ['1 period with use unknown', '1 card without an anniversary month']);
  assert.equal(nights.noun, 'free night');
  assert.equal(nights.availableNow, null);

  // The dollar credit of the same name is a group of its own.
  assert.deepEqual(memberIds(groupNamed('Free night award', 'credit')), ['card-d/night-credit']);

  // Once every few years: one group across products, by calendar year, with no year total but where it can be used now.
  const traveler = groupNamed('Trusted traveler fee');
  assert.equal(traveler.kind, 'window');
  assert.deepEqual(memberIds(traveler), ['card-a/trusted-traveler', 'card-c/traveler', 'card-b/trusted-traveler']);
  assert.equal(traveler.year, null);
  assert.equal(traveler.availableNow, 3);
  assert.deepEqual(traveler.members.map(({ benefit }) => benefitTerms(benefit)), [
    '$120 · Once every 4 years', '$100 · Once every 4 years', '$120 · Once every 4 years',
  ]);
  assert.deepEqual(tagLabels(traveler.sharedTags), ['Once every 4 years']);
  // Used last year on one card: that card can use it again only in four years.
  const used = reportWith([...CREDITS, {
    id: 'row-3', cardAccountId: 'card-a', date: '2025-05-06', amountMinor: -12_000, kind: 'adjustment', description: 'SAMPLE TRAVELER CREDIT', merchant: null,
  }]);
  const usedGroups = groupCardsByBenefit(used.cards.filter((card) => card.status === 'active'), TODAY).groups;
  const again = groupNamed('Trusted traveler fee', 'window', usedGroups);
  assert.equal(again.members[0].benefit.window?.nextEligible, '2029-05-06');
  assert.equal(again.availableNow, 2);
  assert.equal(groupCardsByBenefit(used.cards.filter((card) => card.status === 'active'), '2029-05-06').groups
    .find((group) => group.kind === 'window')?.availableNow, 3);
});

test('every compared card without a benefit is listed; cards whose product is unknown, or set to track nothing, are not compared', () => {
  assert.deepEqual(ids(GROUPING.compared), ['card-a', 'card-c', 'card-b', 'card-d', 'card-e']);
  assert.deepEqual(ids(GROUPING.notTracked), ['card-g']);
  assert.deepEqual(ids(GROUPING.unknown), ['card-f']);
  assert.equal(isComparedCard({ product: null }), false);
  assert.deepEqual(ids(groupNamed('Hotel credit (Sample Collection)').missing), ['card-d', 'card-e']);
  assert.deepEqual(ids(groupNamed('Software credit').missing), ['card-c', 'card-d', 'card-e']);
  assert.deepEqual(ids(groupNamed('Free night award', 'credit').missing), ['card-a', 'card-c', 'card-b', 'card-e']);
  for (const group of GROUPING.groups) {
    // A card whose product has nothing to track lacks every benefit; nothing is said of the others.
    assert.ok(ids(group.missing).includes('card-e'), group.name);
    assert.ok(!ids(group.missing).includes('card-f') && !ids(group.missing).includes('card-g'), group.name);
    assert.equal(group.cardCount + group.missing.length, GROUPING.compared.length, group.name);
  }
});

test('groups come by section, in the checklist order; within one, dollar credits by what is available, then counts, then once-every-few-years', () => {
  assert.deepEqual(GROUPING.groups.map((group) => [group.section, group.kind, group.name]), [
    ['travel', 'credit', 'Ride cash'],
    ['travel', 'window', 'Trusted traveler fee'],
    ['hotel', 'credit', 'Hotel credit (Sample Collection)'],
    ['hotel', 'count', 'Free night award'],
    ['dining', 'credit', 'Diner’s credit'],
    ['business', 'credit', 'Software credit'],
    ['business', 'credit', 'Phone credit'],
    // A benefit the catalog files under no category.
    ['other', 'credit', 'Free night award'],
  ]);
  assert.deepEqual(BENEFIT_SECTIONS, ['travel', 'hotel', 'dining', 'shopping', 'business', 'other']);
  assert.equal(new Set(GROUPING.groups.map((group) => group.key)).size, GROUPING.groups.length);
});

test('a section adds up its dollar credits only, and the sections add up to the household\'s totals', () => {
  const inSection = (section: string) => GROUPING.groups.filter((group) => group.section === section);
  // Its once-every-few-years credit stays out; the manual ride cash's unknown months stay counted as unknown.
  assert.deepEqual(sectionYear(inSection('travel')), { capturedMinor: 0, availableMinor: 14_000, unknownPeriods: 10 });
  // The free night is counted, not added to dollars.
  assert.deepEqual(sectionYear(inSection('hotel')), { capturedMinor: 30_000, availableMinor: 180_000, unknownPeriods: 0 });
  assert.deepEqual(sectionYear(inSection('business')), { capturedMinor: 0, availableMinor: 74_000, unknownPeriods: 0 });
  assert.equal(sectionYear(inSection('travel').filter((group) => group.kind === 'window')), null);
  assert.equal(sectionYear([]), null);
  const sum = BENEFIT_SECTIONS.map((section) => sectionYear(inSection(section))).reduce(
    (total, year) => ({ capturedMinor: total.capturedMinor + (year?.capturedMinor ?? 0), availableMinor: total.availableMinor + (year?.availableMinor ?? 0) }),
    { capturedMinor: 0, availableMinor: 0 },
  );
  assert.deepEqual(sum, { capturedMinor: REPORT.household.capturedMinor, availableMinor: REPORT.household.availableMinor });
});

test('the dollar groups add up to the household\'s totals, and to each person\'s', () => {
  const add = (groups: readonly BenefitGroup[]) => groups.filter((group) => group.kind === 'credit').reduce(
    (sum, group) => ({ capturedMinor: sum.capturedMinor + group.year!.capturedMinor, availableMinor: sum.availableMinor + group.year!.availableMinor }),
    { capturedMinor: 0, availableMinor: 0 },
  );
  assert.deepEqual(add(GROUPING.groups), { capturedMinor: REPORT.household.capturedMinor, availableMinor: REPORT.household.availableMinor });
  assert.deepEqual(add(GROUPING.groups), { capturedMinor: 31_500, availableMinor: 309_000 });
  for (const owner of ['alex', 'casey', 'joint'] as const) {
    const { groups } = groupCardsByBenefit(ACTIVE.filter((card) => card.owner === owner), TODAY);
    const totals = REPORT.household.byOwner[owner];
    assert.deepEqual(add(groups), { capturedMinor: totals.capturedMinor, availableMinor: totals.availableMinor }, owner);
  }
});

test('the household\'s use unknown is the report\'s own unknown periods of the dollar totals, never counted as used', () => {
  // The report's own count, in the totals' scope: open cards, dollar credits.
  const reported = (cards: readonly CardBenefitsCardView[]) => cards.flatMap((card) => card.benefits)
    .filter((benefit) => benefit.inTotals).reduce((sum, benefit) => sum + benefit.year.unknownPeriods, 0);
  const unknown = unknownUseOf(ACTIVE);
  assert.equal(unknown.periods, reported(ACTIVE));
  // Marked by hand and not marked yet, Jan–Oct: the ride cash (10 × $10) and the monthly diner's credit (10 × $25); and
  // the manual night credit's year (1 × $50). The same periods the dollar groups say.
  assert.deepEqual(unknown, { periods: 21, availableMinor: 40_000 });
  assert.equal(unknown.periods, GROUPING.groups.filter((group) => group.kind === 'credit')
    .reduce((sum, group) => sum + group.year!.unknownPeriods, 0));
  for (const owner of ['alex', 'casey', 'joint'] as const) {
    const theirs = ACTIVE.filter((card) => card.owner === owner);
    assert.equal(unknownUseOf(theirs).periods, reported(theirs), owner);
  }
});

test('one person\'s cards are compared among themselves', () => {
  const { groups, compared, notTracked, unknown } = groupCardsByBenefit(ACTIVE.filter((card) => card.owner === 'alex'), TODAY);
  assert.deepEqual(ids(compared), ['card-a', 'card-c', 'card-e']);
  assert.deepEqual([notTracked, unknown], [[], []]);
  const hotel = groups.find((group) => group.name === 'Hotel credit (Sample Collection)')!;
  assert.deepEqual(memberIds(hotel), ['card-a/hotel', 'card-c/hotel-stay']);
  assert.deepEqual(ids(hotel.missing), ['card-e']);
  assert.deepEqual(groupCardsByBenefit([], TODAY), { groups: [], compared: [], notTracked: [], unknown: [] });
});

test('cards without a benefit are said by person, then by product, in card order, each card accounted for', () => {
  const card = (cardAccountId: string, owner: CardBenefitsCardView['owner'], productId: string | null, nickname: string, last5: string | null = null) => ({
    cardAccountId, owner, issuer: 'amex', nickname, last4: null, last5,
    product: productId ? { id: productId, shortName: `Product ${productId}` } : null,
  } as unknown as CardBenefitsCardView);
  const byOwner = missingByOwner([
    card('one', 'joint', 'p1', 'One'), card('two', 'alex', 'p1', 'Two', '90002'), card('three', 'alex', 'p2', 'Three'),
    card('four', 'alex', 'p1', 'Four'), card('five', 'alex', null, 'Spare'),
  ]);
  assert.deepEqual(byOwner.map(({ owner, products }) => [owner, products.map(({ name, cards }) => [name, ids(cards)])]), [
    ['alex', [['Product p1', ['two', 'four']], ['Product p2', ['three']], ['Spare', ['five']]]],
    ['joint', [['Product p1', ['one']]]],
  ]);
  // A card with no ending beside one with an ending still counts; so do two without.
  assert.deepEqual(byOwner[0].products.map(missingProductLabel), ['Product p1 ··90002 +1', 'Product p2', 'Spare']);
  const named = (...endings: Array<string | null>) => ({
    name: 'Gold', cards: endings.map((last5, index) => card(`c${index}`, 'alex', 'g', 'Gold', last5)),
  });
  assert.equal(missingProductLabel(named('63061', '66221')), 'Gold ··63061 ··66221');
  assert.equal(missingProductLabel(named('63061', null, null)), 'Gold ··63061 +2');
  assert.equal(missingProductLabel(named(null, null)), 'Gold ×2');
  assert.equal(missingProductLabel(named(null)), 'Gold');
});

test('what an issuer reported outside the catalog is grouped by its tracker, across cards', () => {
  const tracker = (issuerBenefitId: string, name: string): BenefitIssuerFigure => ({
    issuerBenefitId, name, observedAt: '2026-10-20T10:00:00.000Z', stale: false, usedMinor: 1, totalMinor: 2,
    enrollment: 'unknown', resetDate: null,
  });
  const withTrackers = ACTIVE.map((card) => {
    if (card.cardAccountId === 'card-b') return { ...card, issuerTrackers: [tracker('sample.perk', 'Sample perk')] };
    if (card.cardAccountId === 'card-a') return { ...card, issuerTrackers: [tracker('sample.perk', 'Sample perk'), tracker('sample.other', 'Other perk')] };
    if (card.cardAccountId === 'card-d') return { ...card, issuerTrackers: [tracker('sample.perk', 'Sample perk')] };
    return card;
  });
  assert.deepEqual(issuerTrackerGroups(withTrackers).map((group) => [group.name, group.entries.map(({ card }) => card.cardAccountId)]), [
    ['Sample perk', ['card-a', 'card-b']],
    ['Other perk', ['card-a']],
    // Another issuer's tracker of the same id is its own.
    ['Sample perk', ['card-d']],
  ]);
  assert.deepEqual(issuerTrackerGroups(ACTIVE), []);
});

test('the shipped catalog never gives one card two benefits of one group', () => {
  for (const product of BENEFITS_CATALOG.products) {
    const idByKey = new Map<string, string>();
    for (const benefit of product.benefits) {
      const key = benefitGroupKey({
        name: benefit.name,
        compareAs: benefit.compareAs,
        unit: benefit.value.unit,
        noun: benefit.value.unit === 'count' ? benefit.value.noun : undefined,
        inTotals: benefit.value.unit === 'usd' && benefit.cadence.every !== 'years',
      });
      const seen = idByKey.get(key);
      assert.ok(seen === undefined || seen === benefit.id, `${product.id}: ${seen} and ${benefit.id} would be one group`);
      idByKey.set(key, benefit.id);
    }
  }
});

test('the shipped catalog compares exactly these benefits across products, in every year it covers', () => {
  // One card of each product, each placed in its cardmember year, for every year the catalog's versions reach: which
  // groups hold more than one product. A catalog change that adds, removes or alters a cross-product group must be
  // checked to be one program's benefit, then listed here; every card of a group must sit in one section.
  const cards = BENEFITS_CATALOG.products.map((product) => ({
    account: account(`card-${product.id}`, { issuer: product.issuer, owner: 'alex', nickname: 'Sample' }),
    settings: settings(`card-${product.id}`, { productChoice: 'manual', productId: product.id, anniversaryMonth: 1 }),
  }));
  const crossProduct = new Map<string, Set<string>>();
  const names = new Map<number, string[]>();
  for (const year of [2024, 2025, 2026, 2027, 2028, 2029, 2030]) {
    const report = computeCardBenefitsReport({ catalog: BENEFITS_CATALOG, year, today: `${year}-06-15`, cards, credits: [], marks: [], trackers: [] });
    const { groups } = groupCardsByBenefit(report.cards, `${year}-06-15`);
    names.set(year, groups.map((group) => group.name));
    for (const group of groups) {
      assert.equal(new Set(group.members.map(({ benefit }) => benefit.category)).size, 1, `${year} ${group.name}`);
      const products = new Set(group.members.map(({ card }) => card.product!.id));
      if (products.size > 1) crossProduct.set(group.name, new Set([...(crossProduct.get(group.name) ?? []), ...products]));
    }
  }
  assert.deepEqual([...crossProduct].map(([name, products]) => [name, [...products].sort()]).sort(([a], [b]) => (a < b ? -1 : 1)), [
    ['Airline fee credit', ['amex-business-platinum', 'amex-platinum']],
    ['CLEAR+ credit', ['amex-business-platinum', 'amex-hilton-aspire', 'amex-platinum']],
    ['ChatGPT Business credit', ['amex-business-gold', 'amex-business-platinum']],
    ['Delta Stays credit', ['amex-delta-gold-business', 'amex-delta-reserve-business']],
    ['DoorDash promo', ['chase-freedom', 'chase-freedom-unlimited', 'chase-sapphire-preferred']],
    ['Global Entry or TSA PreCheck fee', [
      'amex-business-platinum', 'amex-delta-reserve-business', 'amex-marriott-brilliant', 'amex-platinum', 'chase-sapphire-preferred',
      'citi-aadvantage-executive', 'citi-strata-elite',
    ]],
    ['Hilton credit', ['amex-business-platinum', 'amex-hilton-business']],
    ['Hotel credit', ['citi-strata-elite', 'citi-strata-premier']],
    ['Hotel credit (FHR / The Hotel Collection)', ['amex-business-platinum', 'amex-platinum']],
    ['Marriott free night', ['amex-marriott-brilliant', 'chase-marriott-boundless']],
    ['Resy credit', ['amex-delta-reserve-business', 'amex-gold', 'amex-platinum']],
    ['Rideshare credit', ['amex-delta-gold-business', 'amex-delta-reserve-business']],
    ['Uber Cash', ['amex-gold', 'amex-platinum']],
    ['Walmart+ credit', ['amex-business-gold', 'amex-platinum']],
  ]);
  // Same name, other programs: each its own.
  const in2026 = names.get(2026)!;
  for (const name of ['Dining credit', 'Brilliant dining credit', 'Hilton free night', 'Hyatt free night', 'IHG free night', 'Omni Hotels free night']) {
    assert.equal(in2026.filter((entry) => entry === name).length, 1, name);
  }
  assert.ok(![...names.values()].some((list) => list.includes('Free night award')));
});

test('a group says how often once when every card agrees, and the amount with it only when that agrees too', () => {
  // How often alike, the amounts not: how often for the group, each card its amount.
  const traveler = groupNamed('Trusted traveler fee');
  const travelerTags = groupTags(traveler.members.map(({ benefit }) => benefit));
  assert.deepEqual(tagLabels(travelerTags.shared), ['Once every 4 years']);
  assert.deepEqual(travelerTags.own.map(tagLabels), [['$120'], ['$100'], ['$120']]);
  // Both alike: one tag for the group; a card says only what it alone has.
  const hotel = groupNamed('Hotel credit (Sample Collection)');
  const hotelTags = groupTags(hotel.members.map(({ benefit }) => benefit));
  assert.deepEqual(tagLabels(hotelTags.shared), ['$300 · Twice a year']);
  assert.deepEqual(hotelTags.own.map(tagLabels), [[], ['Enrollment required'], []]);
  // How often differs: each card its own terms, even where the amounts agree ("$15" alone would mislead).
  const [quarterly] = groupNamed('Diner’s credit').members.map(({ benefit }) => benefit);
  const monthly: BenefitView = { ...quarterly, cadenceLabel: 'Monthly' };
  const differ = groupTags([quarterly, monthly]);
  assert.deepEqual(tagLabels(differ.shared), []);
  assert.deepEqual(differ.own.map(tagLabels), [['$15 · Quarterly'], ['$15 · Monthly']]);
  // One card: everything is said for the group, nothing on the card; no cards, nothing.
  assert.deepEqual(groupTags([quarterly]).own, [[]]);
  assert.deepEqual(groupTags([]), { shared: [], own: [] });
});
