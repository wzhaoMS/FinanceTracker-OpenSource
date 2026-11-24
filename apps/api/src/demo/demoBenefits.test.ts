import { describe, expect, it } from 'vitest';

import {
  BENEFITS_CATALOG,
  benefitAppliesOn,
  benefitCreditValue,
  benefitPattern,
  cardMetalsMerchantClass,
  computeCardBenefitsReport,
  type BenefitCreditRow,
  type CardAccount,
  type CardBenefitsReport,
} from '@finance-tracker/shared';

import { buildDemoBenefitCredits, demoCardProduct } from './demoBenefits.js';
import { DEMO_CARDS, demoHistoryStart, type DemoCardKey } from './demoCards.js';
import { buildDemoSpending } from './demoData.js';

// The Benefits tab's showcase: the demo's premium cards, their statement credits per period (used in full, in part or
// not at all, each after the purchase it rewards), Uber Cash marks, a credit taken back, the grace rule, a Global Entry
// window and the annual fees, read through the same report the API serves, on days spread over several years.

const DATES = ['2026-03-18', '2026-07-02', '2026-11-24', '2027-01-05', '2028-06-15'];
const idOf = (key: DemoCardKey) => `card-${key}`;

function reports(today: string): { current: CardBenefitsReport; previous: CardBenefitsReport } {
  const spending = buildDemoSpending(today);
  const cards = DEMO_CARDS.map((card) => ({
    account: {
      id: idOf(card.key), issuer: card.issuer, owner: card.owner, nickname: card.nickname, last4: card.last4,
      currency: 'USD', status: 'active', createdAt: `${today}T00:00:00.000Z`, updatedAt: `${today}T00:00:00.000Z`,
    } satisfies CardAccount,
    settings: {
      cardAccountId: idOf(card.key), productChoice: card.productChoice, productId: null, anniversaryMonth: card.anniversaryMonth,
      updatedAt: `${today}T00:00:00.000Z`,
    },
  }));
  const credits: BenefitCreditRow[] = spending.rows.filter((row) => row.status === 'posted').map((row, index) => ({
    id: `row-${index}`, cardAccountId: idOf(row.card), date: row.transactionDate, amountMinor: row.amountMinor, kind: row.kind,
    description: row.description, merchant: row.merchant ?? null,
  }));
  const marks = spending.marks.map((mark) => ({
    cardAccountId: idOf(mark.card), benefitId: mark.benefitId, periodStart: mark.periodStart, status: mark.status,
    usedMinor: mark.usedMinor, markedAt: `${today}T12:00:00.000Z`,
  }));
  const year = Number(today.slice(0, 4));
  const report = (shown: number) => computeCardBenefitsReport({ catalog: BENEFITS_CATALOG, year: shown, today, cards, credits, marks, trackers: [] });
  return { current: report(year), previous: report(year - 1) };
}

const cardOf = (report: CardBenefitsReport, key: DemoCardKey) => report.cards.find((card) => card.cardAccountId === idOf(key))!;

describe('the demo household\'s card benefits', () => {
  it.each(DATES)('fill the Benefits tab on %s: products, fees, owners, used, partial and unused periods with deadlines', (today) => {
    const { current, previous } = reports(today);
    expect(cardOf(current, 'alex-gold').product?.id).toBe('amex-gold');
    expect(cardOf(current, 'casey-platinum').product?.id).toBe('amex-platinum');
    expect(cardOf(current, 'joint-strata').product?.id).toBe('citi-strata-elite');
    expect(cardOf(current, 'casey-visa')).toMatchObject({ product: null, productSource: 'none', productChoice: 'none' });
    expect(cardOf(current, 'joint-cash')).toMatchObject({ product: null, productSource: 'none', productChoice: 'none' });
    // No card waits to be set up, so the household summary counts every card's credits ("Not counted yet" stays away).
    expect(current.cards.every((card) => (card.product !== null || card.productChoice === 'none') && !card.needsAnniversary)).toBe(true);
    expect(current.household.annualFeesMinor).toBe(32_500 + 89_500 + 59_500);
    expect(current.household.byOwner).toMatchObject({
      alex: { annualFeesMinor: 32_500 }, casey: { annualFeesMinor: 89_500 }, joint: { annualFeesMinor: 59_500 },
    });

    // Each premium card, over this year and last: a period used in full, one in part and one not at all, all past.
    for (const key of ['alex-gold', 'casey-platinum', 'joint-strata'] as const) {
      const periods = [cardOf(current, key), cardOf(previous, key)].flatMap((card) => card.benefits)
        .filter((benefit) => benefit.inTotals).flatMap((benefit) => benefit.periods)
        .filter((period) => period.active && period.state === 'past' && period.usedMinor !== null);
      expect(periods.some((period) => period.usedMinor! >= period.availableMinor), `${key}: used in full`).toBe(true);
      expect(periods.some((period) => period.usedMinor! > 0 && period.usedMinor! < period.availableMinor), `${key}: used in part`).toBe(true);
      expect(periods.some((period) => period.usedMinor === 0), `${key}: not used`).toBe(true);
    }
    // Reimbursed credits are listed with their amounts and dates; what is left has days left.
    const matches = current.cards.concat(previous.cards).flatMap((card) => card.benefits).flatMap((benefit) => benefit.periods)
      .flatMap((period) => period.matches);
    expect(matches.length).toBeGreaterThan(20);
    expect(matches.every((match) => match.amountMinor !== 0 && /^\d{4}-\d{2}-\d{2}$/.test(match.date))).toBe(true);
    const open = current.cards.flatMap((card) => card.benefits).map((benefit) => benefit.current)
      .filter((period) => period !== null && (period.remainingMinor ?? 1) > 0);
    expect(open.length).toBeGreaterThan(3);
    expect(open.every((period) => period!.daysLeft >= 1)).toBe(true);
    expect(previous.household.capturedMinor).toBeGreaterThan(0);
  });

  it.each(DATES)('shows the grace rule, a credit taken back, Global Entry and Uber Cash marks on %s', (today) => {
    const { current, previous } = reports(today);
    const platinum = [cardOf(current, 'casey-platinum'), cardOf(previous, 'casey-platinum')];
    const periods = (id: string) => platinum.flatMap((card) => card.benefits.filter((benefit) => benefit.id === id)).flatMap((benefit) => benefit.periods);
    // A credit posted early in a month counts for the month before, which it fills.
    const graced = periods('digital-entertainment').filter((period) => period.matches.some((match) => match.date > period.end));
    expect(graced.some((period) => period.state === 'past' && period.usedMinor === period.availableMinor)).toBe(true);
    // Saks: a credit, then the purchase returned and the credit taken back: nothing used.
    const reversed = periods('saks').filter((period) => period.matches.length === 2 && period.matches.reduce((sum, match) => sum + match.amountMinor, 0) === 0);
    expect(reversed.some((period) => period.state === 'past' && period.usedMinor === 0 && period.source === 'derived')).toBe(true);
    // Global Entry: used on the Platinum card (next eligible four years later), still available on the Strata Elite.
    const entry = cardOf(current, 'casey-platinum').benefits.find((benefit) => benefit.id === 'global-entry-tsa')!;
    expect(entry.window?.lastUsed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number(entry.window!.nextEligible!.slice(0, 4)) - Number(entry.window!.lastUsed!.slice(0, 4))).toBe(4);
    expect(cardOf(current, 'joint-strata').benefits.find((benefit) => benefit.id === 'global-entry-tsa')!.window).toEqual({ lastUsed: null, nextEligible: null });
    // Uber Cash never posts to the card: the months of the card history carry the owner's marks.
    for (const key of ['alex-gold', 'casey-platinum'] as const) {
      const uber = [cardOf(current, key), cardOf(previous, key)].flatMap((card) => card.benefits.filter((benefit) => benefit.id === 'uber-cash'))
        .flatMap((benefit) => benefit.periods).filter((period) => period.state === 'past' && period.active && period.start >= demoHistoryStart(today));
      expect(uber.length).toBeGreaterThan(0);
      expect(uber.every((period) => period.source === 'manual')).toBe(true);
    }
  });

  it.each(DATES)('makes every credit read as exactly one benefit, after the purchase it rewards, on %s', (today) => {
    const { rows } = buildDemoBenefitCredits(today);
    const readersOf = (row: (typeof rows)[number]) => {
      const product = demoCardProduct(DEMO_CARDS.find((entry) => entry.key === row.card)!)!;
      return new Set(product.benefits.filter((benefit) => benefit.tracking.method === 'statement-credit' && benefitAppliesOn(benefit, row.transactionDate))
        .filter((benefit) => {
          const tracking = benefit.tracking as Extract<typeof benefit.tracking, { method: 'statement-credit' }>;
          const patterns = row.kind === 'adjustment' ? [...tracking.patterns, ...(tracking.adjustmentPatterns ?? [])] : tracking.patterns;
          return patterns.some((source) => [row.description, row.merchant ?? ''].some((text) => text !== '' && benefitPattern(source).test(text)));
        }).map((benefit) => benefit.id));
    };
    // The issuers file their credits (and a credit taken back) under fees and adjustments; a store's refund is no credit.
    const credits = rows.filter((row) => row.kind === 'adjustment');
    expect(credits.length).toBeGreaterThan(15);
    expect(rows.filter((row) => row.kind === 'refund' && benefitCreditValue(row) !== null).every((row) => readersOf(row).size === 0)).toBe(true);
    for (const row of credits) {
      // No double keywords: one benefit's patterns, and no other's, read the line (whatever the catalog order).
      expect([...readersOf(row)], `${row.description} on ${row.transactionDate}`).toHaveLength(1);
      // Credits follow a purchase on the same card that cost at least as much; a reversal follows its credit.
      if (row.amountMinor < 0) {
        expect(rows.some((purchase) => purchase.card === row.card && purchase.kind === 'purchase' && purchase.amountMinor >= -row.amountMinor
          && purchase.transactionDate <= row.transactionDate && purchase.transactionDate >= `${Number(row.transactionDate.slice(0, 4)) - 1}${row.transactionDate.slice(4)}`),
        `${row.description} on ${row.transactionDate}`).toBe(true);
      }
    }
    // Credits post all through the month, not only at its end.
    const early = credits.filter((row) => Number(row.transactionDate.slice(8, 10)) <= 15).length;
    expect(early / credits.length).toBeGreaterThan(0.3);
    // No benefit purchase reads as a possible bullion purchase (Walmart.com, a dealer): Walmart+ is WALMART PLUS.
    expect(rows.filter((row) => cardMetalsMerchantClass(row) !== null)).toEqual([]);
    // The annual fees: one a year on each fee card's anniversary month, at the catalog's fee.
    const fees = rows.filter((row) => row.kind === 'fee');
    expect(new Set(fees.map((row) => row.card))).toEqual(new Set(['alex-gold', 'casey-platinum', 'joint-strata']));
    expect(fees.every((row) => row.amountMinor === demoCardProduct(DEMO_CARDS.find((card) => card.key === row.card)!)!.annualFeeMinor)).toBe(true);
  });

  it.each(['2026-03-31', '2026-06-30'])('reminds of credits still unused as their periods end on %s', (today) => {
    const { current } = reports(today);
    expect(current.resetsSoon.length).toBeGreaterThan(0);
    expect(current.resetsSoon.every((reminder) => reminder.end >= today && reminder.daysLeft >= 1)).toBe(true);
    expect(current.resetsSoon.some((reminder) => reminder.end === today)).toBe(true);
  });

  it('keeps a past period the same whichever later day the demo is made on', () => {
    const before = buildDemoBenefitCredits('2026-11-24').rows.filter((row) => row.transactionDate.startsWith('2026-06'));
    const after = buildDemoBenefitCredits('2026-12-09').rows.filter((row) => row.transactionDate.startsWith('2026-06'));
    expect(after).toEqual(before);
  });
});
