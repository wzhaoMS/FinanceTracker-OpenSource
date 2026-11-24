import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeCardBenefitsReport,
  type BenefitPeriodView,
  type BenefitProduct,
  type BenefitView,
  type CardAccount,
  type CardBenefitSettings,
  type CardBenefitsCardView,
} from '@finance-tracker/shared';

import {
  annualFeesText,
  cardEndingLabel,
  cardTitle,
  creditsMinusFeesText,
  creditsUsedNote,
  currentLine,
  daysLeftLabel,
  feeCoverage,
  formatBenefitAmount,
  formatBenefitUsd,
  groupBenefitCards,
  missingCountText,
  notCountedYetText,
  periodCellLabel,
  periodFill,
  periodRange,
  reminderDeadline,
  reminderLeft,
  setupReason,
  setupSummaryText,
  shortDate,
  sourceLabel,
  unknownUseOf,
  unknownUseText,
  usageTierText,
  usedFraction,
  usedOfAvailable,
} from './benefitsFormat';

const usd = { unit: 'usd' as const };
const night = { unit: 'count' as const, noun: 'free night' };

function period(patch: Partial<BenefitPeriodView> = {}): BenefitPeriodView {
  return {
    start: '2026-10-01', end: '2026-10-31', label: 'Oct', state: 'current', active: true, availableMinor: 2500, usedMinor: 1000,
    source: 'derived', derivedMinor: 1000, matches: [], mark: null, issuer: null, ...patch,
  };
}

test('amounts read as dollars without needless cents, or as counts of their noun', () => {
  assert.equal(formatBenefitUsd(1500), '$15');
  assert.equal(formatBenefitUsd(1295), '$12.95');
  assert.equal(formatBenefitUsd(120000), '$1,200');
  assert.equal(formatBenefitAmount(night, 1), '1 free night');
  assert.equal(formatBenefitAmount({ unit: 'count', noun: 'certificate' }, 2), '2 certificates');
  assert.equal(formatBenefitAmount({ unit: 'count', noun: 'activation' }, 0), '0 activations');
  assert.equal(usedOfAvailable(usd, 1000, 2500), '$10 of $25');
  assert.equal(usedOfAvailable(usd, null, 2500), '— of $25');
  assert.equal(usedOfAvailable(night, 0, 1), '0 of 1 free night');
});

test('a period is drawn by how much of it was used, and unknown is never empty', () => {
  assert.equal(periodFill(period()), 'partial');
  assert.equal(periodFill(period({ usedMinor: 2500 })), 'full');
  assert.equal(periodFill(period({ usedMinor: 0, state: 'past' })), 'none');
  assert.equal(periodFill(period({ usedMinor: 0, state: 'future' })), 'future');
  assert.equal(periodFill(period({ usedMinor: null, state: 'past' })), 'unknown');
  assert.equal(periodFill(period({ usedMinor: null, state: 'future' })), 'future');
  assert.equal(periodFill(period({ active: false })), 'inactive');
  assert.equal(usedFraction(1000, 2500), 0.4);
  assert.equal(usedFraction(5000, 2500), 1);
  assert.equal(usedFraction(null, 2500), 0);
  assert.equal(usedFraction(10, 0), 0);
});

test('periods, dates and sources are said in words', () => {
  assert.equal(periodRange({ start: '2026-07-01', end: '2026-12-31' }), 'Jul 1 – Dec 31, 2026');
  assert.equal(periodRange({ start: '2026-03-01', end: '2027-02-28' }), 'Mar 1, 2026 – Feb 28, 2027');
  assert.equal(shortDate('2026-10-05', '2026-10-27'), 'Oct 5');
  assert.equal(shortDate('2025-10-05', '2026-10-27'), 'Oct 5, 2025');
  assert.equal(daysLeftLabel(1), 'Last day');
  assert.equal(daysLeftLabel(5), '5 days left');
  const issuer = {
    issuerBenefitId: 'x', name: 'X', observedAt: '2026-10-20T10:00:00.000Z', stale: true, usedMinor: 1, totalMinor: 2,
    enrollment: 'unknown' as const, resetDate: null,
  };
  assert.equal(sourceLabel('issuer', issuer, '2026-10-27'), 'Issuer · as of Oct 20 (stale)');
  assert.equal(sourceLabel('manual', null, '2026-10-27'), 'Marked by you');
  assert.equal(sourceLabel('derived', null, '2026-10-27'), 'From statement credits');
  assert.equal(sourceLabel('none', null, '2026-10-27'), 'Not marked');
  const benefit = { unit: 'usd', noun: undefined } as unknown as BenefitView;
  assert.equal(periodCellLabel(benefit, period(), '2026-10-27'), 'Oct (now): $10 of $25 · From statement credits');
  assert.equal(periodCellLabel(benefit, period({ active: false }), '2026-10-27'), 'Oct: not offered then');
});

test('the current period says what is left and for how long', () => {
  const current = { ...period(), daysLeft: 5, remainingMinor: 1500, resetsSoon: true };
  assert.equal(currentLine(usd, current), '$15 left · 5 days left');
  assert.equal(currentLine(usd, { ...current, remainingMinor: null }), 'Not marked yet · 5 days left');
  assert.equal(currentLine(usd, { ...current, remainingMinor: null, source: 'issuer' }), 'Use not reported · 5 days left');
  assert.equal(currentLine(usd, { ...current, remainingMinor: 0 }), 'Used · renews after Oct 31');
  assert.equal(feeCoverage(30000, 69500), 43);
  assert.equal(feeCoverage(30000, null), null);
});

test('cards group by issuer, Amex, Chase and Citi first, then by person', () => {
  const card = (cardAccountId: string, issuer: string, owner: CardBenefitsCardView['owner']) =>
    ({ cardAccountId, issuer, owner, product: null, nickname: null, last4: null, last5: null } as unknown as CardBenefitsCardView);
  const groups = groupBenefitCards([
    card('a', 'citi', 'alex'), card('b', 'amex', 'casey'), card('c', 'samplebank', 'joint'), card('d', 'amex', 'alex'), card('e', 'chase', 'alex'),
  ]);
  assert.deepEqual(groups.map((group) => [group.issuer, group.owners.map((entry) => [entry.owner, entry.cards.map((item) => item.cardAccountId)])]), [
    ['amex', [['alex', ['d']], ['casey', ['b']]]],
    ['chase', [['alex', ['e']]]],
    ['citi', [['alex', ['a']]]],
    ['samplebank', [['joint', ['c']]]],
  ]);
  const named = { issuer: 'amex', nickname: 'Sample', product: null, last4: '0009', last5: '90009' };
  assert.equal(cardTitle(named), 'Sample');
  assert.equal(cardTitle({ ...named, nickname: null }), 'Amex');
  assert.equal(cardEndingLabel(named), '··90009');
  assert.equal(cardEndingLabel({ last4: null, last5: null }), '');
});

test('a card to set up says what it still needs, and the folded list says it for all in one line', () => {
  const product = { id: 'sample', name: 'Sample Card', shortName: 'Sample', annualFeeMinor: 0, feeVerify: false, sourceUrl: '' };
  assert.equal(setupReason({ product: null, productSource: 'none', needsAnniversary: false }), 'Choose its product');
  assert.equal(setupReason({ product: null, productSource: 'missing', needsAnniversary: false }), 'Its product left the catalog: choose another');
  assert.equal(setupReason({ product, productSource: 'auto', needsAnniversary: true }), 'Set its anniversary month');
  assert.equal(setupReason({ product, productSource: 'auto', needsAnniversary: false }), '');
  const needs = (withProduct: number, anniversary: number) => [
    ...Array.from({ length: withProduct }, () => ({ product: null, needsAnniversary: false })),
    ...Array.from({ length: anniversary }, () => ({ product, needsAnniversary: true })),
  ];
  assert.equal(setupSummaryText(needs(1, 0)), '1 needs a product');
  assert.equal(setupSummaryText(needs(0, 1)), '1 needs an anniversary month');
  assert.equal(setupSummaryText(needs(2, 12)), '2 need a product, 12 need an anniversary month');
  // A card without its product is counted once, as needing its product, whatever else it lacks.
  assert.equal(setupSummaryText([{ product: null, needsAnniversary: true }]), '1 needs a product');
});

test('the cards without a benefit are counted against the cards compared', () => {
  assert.equal(missingCountText(12, 20), '12 of 20 compared cards');
  assert.equal(missingCountText(1, 1), '1 of 1 compared card');
});

test('a reminder says what is left, or that its use is unknown and why, never $0; then by when', () => {
  assert.deepEqual(reminderLeft(usd, { remainingMinor: 1295, source: 'derived' }), { text: '$12.95 left', why: null });
  assert.deepEqual(reminderLeft(night, { remainingMinor: 1, source: 'manual' }), { text: '1 free night left', why: null });
  assert.deepEqual(reminderLeft(usd, { remainingMinor: null, source: 'none' }), { text: 'Use unknown', why: 'not marked yet' });
  assert.deepEqual(reminderLeft(usd, { remainingMinor: null, source: 'issuer' }), { text: 'Use unknown', why: 'not reported by the issuer' });
  assert.equal(reminderDeadline({ end: '2026-10-31', daysLeft: 5 }, '2026-10-27'), 'Use by Oct 31 · 5 days left');
  assert.equal(reminderDeadline({ end: '2026-10-31', daysLeft: 1 }, '2026-10-31'), 'Use by Oct 31 · Last day');
  // A cardmember year that ends next year says the year.
  assert.equal(reminderDeadline({ end: '2027-01-31', daysLeft: 35 }, '2026-12-28'), 'Use by Jan 31, 2027 · 35 days left');
});

test('the year\'s figures: credits used, the periods whose use is unknown apart, then the fees and the difference', () => {
  const benefit = (inTotals: boolean, periods: BenefitPeriodView[]) => ({ inTotals, periods }) as unknown as BenefitView;
  const card = (...benefits: BenefitView[]) => ({ benefits });
  const cards = [
    card(
      // A month marked by hand and not marked yet, one the issuer gave no figure for, one known, and one ahead.
      benefit(true, [
        period({ label: 'Sep', state: 'past', usedMinor: null, source: 'none', availableMinor: 1500 }),
        period({ label: 'Oct', usedMinor: null, source: 'issuer', availableMinor: 1500 }),
        period({ label: 'Aug', state: 'past', usedMinor: 0, availableMinor: 1500 }),
        period({ label: 'Nov', state: 'future', usedMinor: null, availableMinor: 1500 }),
      ]),
      // Not in the dollar totals (a count, or a once-every-few-years credit), and a period it did not exist in.
      benefit(false, [period({ usedMinor: null, availableMinor: 1 })]),
      benefit(true, [period({ active: false, usedMinor: null, availableMinor: 0 })]),
    ),
    card(benefit(true, [period({ state: 'past', usedMinor: null, availableMinor: 3500 })])),
  ];
  assert.deepEqual(unknownUseOf(cards), { periods: 3, availableMinor: 6500 });
  assert.deepEqual(unknownUseOf([]), { periods: 0, availableMinor: 0 });
  assert.equal(unknownUseText({ periods: 3, availableMinor: 6500 }), '3 periods ($65 in credits)');
  assert.equal(unknownUseText({ periods: 1, availableMinor: 1500 }), '1 period ($15 in credits)');

  assert.equal(creditsUsedNote({ capturedMinor: 60_000, availableMinor: 575_340 }, 2026), 'of $5,753.40 available in 2026 · 10%');
  assert.equal(creditsUsedNote({ capturedMinor: 0, availableMinor: 0 }, 2026), 'No dollar credits counted in 2026');
  assert.equal(annualFeesText({ capturedMinor: 60_000, annualFeesMinor: 194_000 }), 'Annual fees $1,940 · credits used cover 31% of them');
  assert.equal(annualFeesText({ capturedMinor: 60_000, annualFeesMinor: 0 }), 'No annual fees');
  // A difference, signed, never coloured or called a saving.
  assert.equal(creditsMinusFeesText({ capturedMinor: 60_000, annualFeesMinor: 194_000 }), 'Credits used minus annual fees: −$1,340 (dollar credits only)');
  assert.equal(creditsMinusFeesText({ capturedMinor: 30_000, annualFeesMinor: 25_000 }), 'Credits used minus annual fees: $50 (dollar credits only)');
  assert.equal(creditsMinusFeesText({ capturedMinor: 25_000, annualFeesMinor: 25_000 }), 'Credits used minus annual fees: $0 (dollar credits only)');
});

test('credits a card cannot place yet are said not counted, never read as no credits (the shared report)', () => {
  // Made up: a product whose one dollar credit renews each cardmember year, so it needs the card's anniversary month.
  const product: BenefitProduct = {
    id: 'amex-synthetic-anniversary', issuer: 'amex', name: 'Synthetic Anniversary Card', shortName: 'Synthetic Anniversary',
    nicknamePatterns: ['^synthetic anniversary$'], annualFeeMinor: 10_000, sourceUrl: 'https://example.invalid/synthetic',
    benefits: [{
      id: 'anniversary-credit', name: 'Synthetic anniversary credit', kind: 'credit', category: 'travel',
      value: { unit: 'usd', amountMinor: 20_000 }, cadence: { every: 'year', basis: 'cardmember' },
      enrollment: false, tracking: { method: 'manual', reason: 'not-itemized' },
    }],
  };
  const account = (id: string, nickname: string): CardAccount => ({
    id, issuer: 'amex', owner: 'alex', nickname, currency: 'USD', status: 'active', last4: '0001',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const settings = (cardAccountId: string, patch: Partial<CardBenefitSettings>): CardBenefitSettings => ({
    cardAccountId, productChoice: 'auto', productId: null, anniversaryMonth: null, updatedAt: '2026-01-01T00:00:00.000Z', ...patch,
  });
  const reportOf = (cards: Array<{ account: CardAccount; settings: CardBenefitSettings | null }>) => computeCardBenefitsReport({
    catalog: { version: 'synthetic', products: [product] }, year: 2026, today: '2026-10-27', cards, credits: [], marks: [], trackers: [],
  });
  const anniversaryCard = (anniversaryMonth: number | null) => ({
    account: account('card-anniversary', 'Synthetic Anniversary'), settings: settings('card-anniversary', { anniversaryMonth }),
  });

  // No anniversary month: the report counts nothing available, which is no proof there is no credit.
  const unplaced = reportOf([anniversaryCard(null)]);
  assert.deepEqual([unplaced.cards[0].product?.id, unplaced.cards[0].benefits[0].needsAnniversary, unplaced.cards[0].benefits[0].inTotals],
    [product.id, true, true]);
  assert.equal(unplaced.household.availableMinor, 0);
  assert.equal(creditsUsedNote(unplaced.household, 2026), 'No dollar credits counted in 2026');
  assert.equal(notCountedYetText(unplaced.cards), 'credits on 1 card that needs an anniversary month');
  assert.deepEqual(unknownUseOf(unplaced.cards), { periods: 0, availableMinor: 0 });

  // Its month set: the same $200, its use not known yet, and nothing left out.
  const placed = reportOf([anniversaryCard(3)]);
  assert.equal(placed.household.availableMinor, 20_000);
  assert.equal(creditsUsedNote(placed.household, 2026), 'of $200 available in 2026 · 0%');
  assert.deepEqual(unknownUseOf(placed.cards), { periods: 1, availableMinor: 20_000 });
  assert.equal(notCountedYetText(placed.cards), null);

  // A card whose product is not known yet is left out too; one set to track nothing is not, by its owner's choice.
  const mixed = reportOf([
    anniversaryCard(null),
    { account: account('card-mystery', 'Mystery'), settings: null },
    { account: account('card-none', 'Synthetic Anniversary'), settings: settings('card-none', { productChoice: 'none' }) },
  ]);
  assert.deepEqual(mixed.cards.map((card) => [card.product?.id ?? null, card.productChoice]),
    [[product.id, 'auto'], [null, 'auto'], [null, 'none']]);
  assert.equal(notCountedYetText(mixed.cards), 'credits on 1 card that needs a product, and on 1 card that needs an anniversary month');
  assert.equal(notCountedYetText([...mixed.cards, mixed.cards[1]]), 'credits on 2 cards that need a product, and on 1 card that needs an anniversary month');
});

test('Most used: each tier says what puts a benefit in it, over the last 12 months or over a past year', () => {
  const trailing = { trailing: true };
  assert.deepEqual(usageTierText('used', trailing, 2026), {
    title: 'Recorded use', note: 'The most used first: by how many periods had a recorded use in the last 12 months, then by the latest use',
  });
  assert.equal(usageTierText('used', { trailing: false }, 2025).note,
    'The most used first: by how many periods had a recorded use in 2025, then by the latest use');
  // Unknown or not placed is never called unused.
  assert.equal(usageTierText('unknown', trailing, 2026).title, 'Use unknown');
  assert.equal(usageTierText('unplaced', trailing, 2026).title, 'Not placed yet');
  assert.equal(usageTierText('occasional', trailing, 2026).title, 'Occasional');
  assert.deepEqual(usageTierText('unused', { trailing: false }, 2025), {
    title: 'No recorded use', note: 'Nothing recorded in 2025: open one to see its cards',
  });
});
