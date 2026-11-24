import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CardCategoryPart } from './cardCategoryParts.js';
import { computeCardInsights, splitLargeCardPurchases, type CardLargePurchaseSplit, type CardOrderLinks } from './cardInsights.js';
import { cardSpendingExclusionOf, cardSpendingRole, effectiveCardCategory } from './cardSpending.js';
import { resolveCardSpendingExclusions } from './cardSpendingExclusions.js';
import {
  cardSpendingTrend,
  cardSpendingWindow,
  classifyCardSpending,
  compareCardSpending,
  type CardSpendingWindow,
} from './cardSpendingCompare.js';
import { addMonths, daysIn, seededRandom, syntheticSpendingLedger, type SyntheticCardRow } from './__fixtures__/syntheticSpendingLedger.js';

// Synthetic rows only: made-up descriptors, amounts, dates, card ids and order references.
//
// The rule: a refund is set against a large purchase on the same card, in the same merchant group, within 90 days after
// it (oldest first, each purchase up to its amount). A credit linked to orders (the Amazon domain's links, STEP 9) is
// constrained by its link only when the link is decisive: when one of its orders has a charge linked to a card row,
// anywhere in the household. It is then set against a large purchase only when that purchase is one of those charges.
// A credit none of whose orders has a linked charge (a held link, or a charge outside the captured orders) falls back to
// the merchant rule, as does a credit linked to none; and without links every answer is exactly the one before them.

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const within = (date: string, range: { from: string; to: string }) => date >= range.from && date <= range.to;
const monthRange = (month: string) => ({ from: `${month}-01`, to: `${month}-${String(daysIn(month)).padStart(2, '0')}` });
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/**
 * Order links as a snapshot gives them: each row's orders, and each order's charges linked to a card row (its rows with
 * a positive amount) among `household`, every card row, whatever rows a split is then given. `elsewhere` adds charges
 * linked to rows outside them (another card, or before the rows begin).
 */
function orderLinks(
  links: ReadonlyMap<string, readonly string[]>,
  household: readonly SyntheticCardRow[],
  elsewhere: ReadonlyMap<string, readonly string[]> = new Map(),
): CardOrderLinks {
  const charges = new Map<string, string[]>([...elsewhere].map(([order, ids]) => [order, [...ids]]));
  for (const row of household) {
    if (row.amountMinor <= 0) continue;
    for (const order of links.get(row.id) ?? []) charges.set(order, [...(charges.get(order) ?? []), row.id]);
  }
  return { orderRefsOf: (id) => links.get(id), chargeIdsOf: (order) => charges.get(order) };
}
/** Whether a credit's order link is decisive: one of its orders has a linked charge. */
const decisive = (links: CardOrderLinks, id: string) => (links.orderRefsOf(id) ?? []).some((order) => (links.chargeIdsOf(order) ?? []).length > 0);
/** Per refund, the part of it a split set against large purchases, by id. */
const setAgainst = (split: CardLargePurchaseSplit) => [...split.refundsSetAgainstLarge].sort(([a], [b]) => byText(a, b));
/** Each large purchase with what was set against it and what it cost. */
const refunded = (split: CardLargePurchaseSplit) => split.large.map((item) => [item.row.id, item.refundedMinor, item.netMinor]);
const everyday = (split: CardLargePurchaseSplit) => split.everyday.map((row) => [row.id, row.amountMinor]);
const usdSpending = (rows: readonly SyntheticCardRow[]) => rows.filter((row) => row.currency === 'USD' && row.status === 'posted'
  && cardSpendingRole(row.kind) === 'spending' && !cardSpendingExclusionOf(row));

function expectWindowAddsUp(window: CardSpendingWindow, label: string) {
  assert.equal(window.recurringMinor + window.oneOffMinor + window.everydayMinor, window.spendingMinor, `${label}: split`);
  assert.equal(window.chargesMinor + window.creditsMinor, window.spendingMinor, `${label}: charges and credits`);
  assert.equal(sum(window.categories.map((line) => line.amountMinor)), window.spendingMinor, `${label}: categories`);
  assert.equal(sum(window.categories.map((line) => line.oneOffMinor)), window.oneOffMinor, `${label}: category one-offs`);
  assert.equal(sum(window.categories.map((line) => line.everydayMinor)), window.everydayMinor, `${label}: category everyday`);
  assert.equal(window.oneOffs.grossMinor + window.oneOffs.refundsMinor, window.oneOffMinor, `${label}: one-offs`);
  for (const line of window.categories) {
    assert.equal(line.oneOffMinor + line.recurringMinor + line.everydayMinor, line.amountMinor, `${label} ${line.category}: split`);
    const merchants = [...line.merchants, ...(line.otherMerchants ? [line.otherMerchants] : [])];
    assert.equal(sum(merchants.map((item) => item.amountMinor)), line.amountMinor, `${label} ${line.category}: merchants`);
    assert.equal(sum(merchants.map((item) => item.oneOffMinor)), line.oneOffMinor, `${label} ${line.category}: merchant one-offs`);
  }
}

/** What a window says that order links must never move: its totals, and every category's and merchant line's amount. */
function fixedFigures(window: CardSpendingWindow) {
  return {
    totals: [window.spendingMinor, window.chargesMinor, window.creditsMinor, window.count, window.recurringMinor],
    oneOffItems: window.oneOffs.items.map((item) => [item.id, item.amountMinor]),
    recurring: window.recurring,
    categories: window.categories.map((line) => [line.category, line.amountMinor, line.count, line.itemsMinor, line.recurringMinor,
      line.merchants.map((merchant) => [merchant.key, merchant.itemized, merchant.amountMinor, merchant.count, merchant.recurringMinor])]),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// C's composition check (the regression basis), as rows.
// ---------------------------------------------------------------------------------------------------------------------

const C_CARD = 'card-syn-c';
function cRow(id: string, transactionDate: string, amountMinor: number, description: string, issuerCategory: string): SyntheticCardRow {
  return {
    id, cardAccountId: C_CARD, transactionDate, status: 'posted', kind: amountMinor < 0 ? 'refund' : 'purchase', amountMinor,
    currency: 'USD', description, merchant: null, issuerCategory,
  };
}

/**
 * Three synthetic Amazon orders on one card: order 1 (12.00) and its full refund in September; order 2 (14.30 with tax)
 * in September and a 6.60 credit for one of its lines on October 5; order 3, a large 620.00 charge on October 1 and its
 * full refund on October 20; and a 2.50 credit linked to no order on October 7. All three October credits are on the
 * same card, in the same merchant group, within 90 days of order 3's charge. Plus a hardware store and a cafe.
 */
const C_ROWS: SyntheticCardRow[] = [
  cRow('c-order1', '2026-09-02', 1_200, 'AMAZON MKTPL*SYNTH01', 'Shopping'),
  cRow('c-order2', '2026-09-03', 1_430, 'AMAZON MKTPL*SYNTH02', 'Shopping'),
  cRow('c-order1-refund', '2026-09-20', -1_200, 'AMAZON MKTPL*SYNTH03', 'Shopping'),
  cRow('c-order2-credit', '2026-10-05', -660, 'AMAZON MKTPL*SYNTH04', 'Shopping'),
  cRow('c-unlinked-credit', '2026-10-07', -250, 'AMAZON MKTPL*SYNTH05', 'Shopping'),
  cRow('c-hardware', '2026-10-08', 5_000, 'SYNTHETIC HARDWARE STORE', 'Home'),
  cRow('c-hardware-refund', '2026-10-10', -1_000, 'SYNTHETIC HARDWARE STORE', 'Home'),
  cRow('c-cafe', '2026-10-12', 800, 'SYNTHETIC CAFE', 'Dining'),
  cRow('c-order3', '2026-10-01', 62_000, 'AMAZON MKTPL*SYNTH06', 'Shopping'),
  cRow('c-order3-refund', '2026-10-20', -62_000, 'AMAZON MKTPL*SYNTH07', 'Shopping'),
];
/** STEP 9's links in C's check: each order's charge and its credits, charges and credits alike; the 2.50 credit has none. */
const C_LINK_MAP = new Map([
  ['c-order1', ['order-1']], ['c-order1-refund', ['order-1']],
  ['c-order2', ['order-2']], ['c-order2-credit', ['order-2']],
  ['c-order3', ['order-3']], ['c-order3-refund', ['order-3']],
]);
/** Every order's charge is linked to a card row: each credit's link is decisive. */
const C_LINKS = orderLinks(C_LINK_MAP, C_ROWS);
const itemPart = (category: string, amountMinor: number): CardCategoryPart =>
  ({ category, amountMinor, categorySource: 'item-override', classification: amountMinor < 0 ? 'policy-allocated' : 'source' });
/** The item parts each Amazon row is filed under in C's check (its synthetic owner categories, to the cent). */
const C_PARTS = new Map<string, CardCategoryPart[]>([
  ['c-order1', [itemPart('Synthetic Kitchen', 700), itemPart('Synthetic Garden', 500)]],
  ['c-order2', [itemPart('Synthetic Kitchen', 660), itemPart('Synthetic Garden', 440), itemPart('Synthetic Toys', 330)]],
  ['c-order1-refund', [itemPart('Synthetic Kitchen', -700), itemPart('Synthetic Garden', -500)]],
  ['c-order2-credit', [itemPart('Synthetic Kitchen', -660)]],
  ['c-order3', [itemPart('Synthetic Kitchen', 30_000), itemPart('Synthetic Garden', 32_000)]],
  ['c-order3-refund', [itemPart('Synthetic Kitchen', -30_000), itemPart('Synthetic Garden', -32_000)]],
]);
const C_TODAY = '2026-11-15';
const OCTOBER = monthRange('2026-10');
const SEPTEMBER = monthRange('2026-09');
/** A window's category lines as C's check reports them: [category, amount, one-off, everyday]. */
const lines = (window: CardSpendingWindow) => window.categories.map((line) => [line.category, line.amountMinor, line.oneOffMinor, line.everydayMinor])
  .sort(([a], [b]) => byText(String(a), String(b)));

// ---------------------------------------------------------------------------------------------------------------------
// Every branch and condition, on one marketplace.
// ---------------------------------------------------------------------------------------------------------------------

const CARD_A = 'card-syn-a';
const CARD_B = 'card-syn-b';
function edgeRow(id: string, transactionDate: string, amountMinor: number, patch: Partial<SyntheticCardRow> = {}): SyntheticCardRow {
  return {
    id, cardAccountId: CARD_A, transactionDate, status: 'posted', kind: amountMinor < 0 ? 'refund' : 'purchase', amountMinor, currency: 'USD',
    description: `SAMPLE MARKETPLACE*${id.slice(0, 6).toUpperCase()}`, merchant: null, issuerCategory: 'Merchandise & Supplies-Internet Purchase', ...patch,
  };
}

/**
 * Three large purchases on card A at one marketplace (the charge for orders p and q, one linked to no order, and order
 * v's), order x's small charge on card B, and credits around them for each branch of the rule and each condition of
 * the merchant rule; behind them a year of small purchases on card A, so the large-purchase threshold is the floor.
 */
function edgeLedger() {
  const rows: SyntheticCardRow[] = [];
  for (let n = 0; n < 400; n += 1) {
    rows.push(edgeRow(`bg-${String(n).padStart(3, '0')}`, addDays('2025-04-05', Math.floor(n * 0.8)), 1_000 + (n % 7) * 250,
      { description: 'NORTHWIND CAFE', issuerCategory: 'Dining' }));
  }
  rows.push(
    edgeRow('p-charge', '2026-03-02', 300_000), // orders p and q
    edgeRow('u-charge', '2026-03-03', 250_000), // linked to no order
    edgeRow('v-charge', '2026-03-04', 200_000), // order v
    edgeRow('x-charge', '2026-01-15', 5_000, { cardAccountId: CARD_B }), // order x, on card B
    edgeRow('early-credit', '2026-02-20', -8_000), // order p, before its charge
    edgeRow('q-credit', '2026-03-05', -10_000), // order q: decisive, p-charge is its charge
    edgeRow('xp-credit', '2026-03-06', -20_000), // orders x and p: decisive, p-charge is one of its charges
    edgeRow('x-credit', '2026-03-07', -30_000), // order x: decisive, its charge is on card B
    edgeRow('unlinked-credit', '2026-03-08', -40_000), // linked to no order
    edgeRow('y-credit', '2026-03-09', -15_000), // order y, whose charge is linked to no card row: undecided
    edgeRow('other-card-credit', '2026-03-09', -5_000, { cardAccountId: CARD_B }), // order p, another card
    edgeRow('other-merchant-credit', '2026-03-10', -7_000, { description: 'SAMPLE HARDWARE SUPPLY' }), // order p, another merchant
    edgeRow('v-credit', '2026-03-11', -50_000), // order v
    edgeRow('pv-credit', '2026-03-12', -300_000), // orders p and v
    edgeRow('late-credit', '2026-06-15', -6_000), // order p, 105 days after its charge
  );
  const links = new Map<string, string[]>([
    ['p-charge', ['order-p', 'order-q']], ['v-charge', ['order-v']], ['x-charge', ['order-x']],
    ['early-credit', ['order-p']], ['q-credit', ['order-q']], ['xp-credit', ['order-x', 'order-p']], ['x-credit', ['order-x']],
    ['y-credit', ['order-y']], ['other-card-credit', ['order-p']], ['other-merchant-credit', ['order-p']], ['v-credit', ['order-v']],
    ['pv-credit', ['order-p', 'order-v']], ['late-credit', ['order-p']],
  ]);
  return { rows, links };
}

describe('credits linked to an order, in the large one-off split', () => {
  it('C\'s scenario: another order\'s credit no longer offsets the large charge; its own refund and an unlinked credit do', () => {
    const through = OCTOBER.to;
    const before = splitLargeCardPurchases(C_ROWS, { currency: 'USD', through, today: C_TODAY });
    const after = splitLargeCardPurchases(C_ROWS, { currency: 'USD', through, today: C_TODAY, orderLinks: C_LINKS });
    // Before order links (pinned): order 2's credit and the unlinked credit were both set against order 3's charge, oldest
    // first, and order 3's own refund covered only the rest.
    assert.deepEqual(setAgainst(before), [['c-order2-credit', 660], ['c-order3-refund', 61_090], ['c-unlinked-credit', 250]]);
    // Decisive, another order: order 2's credit is not order 3's charge's. Decisive, the same order: order 3's refund
    // covers the rest. Unlinked: the 2.50 credit keeps the merchant rule.
    assert.deepEqual(setAgainst(after), [['c-order3-refund', 61_750], ['c-unlinked-credit', 250]]);
    for (const split of [before, after]) {
      assert.deepEqual(refunded(split), [['c-order3', 62_000, 0]]);
      assert.equal(split.thresholdMinor, 62_000);
    }
    const kept = new Map(everyday(after) as Array<[string, number]>);
    assert.equal(kept.get('c-order2-credit'), -660, 'order 2\'s credit is everyday spending, whole');
    assert.equal(kept.get('c-order3-refund'), -250, 'what is left of order 3\'s refund stays an ordinary refund');
    assert.equal(kept.has('c-unlinked-credit'), false);
    // Undecided: had order 2's charge been held (linked to no card row), Holdr could not tell which purchase its credit
    // belongs to, and the credit would go by the merchant rule, exactly as before.
    const held = orderLinks(new Map([...C_LINK_MAP].filter(([id]) => id !== 'c-order2')), C_ROWS);
    assert.equal(decisive(held, 'c-order2-credit'), false);
    assert.deepEqual(splitLargeCardPurchases(C_ROWS, { currency: 'USD', through, today: C_TODAY, orderLinks: held }), before);

    // The overview's windows, as C's check reads them through the routes: the same categories and totals to the cent;
    // only October's one-off/everyday split of Synthetic Kitchen and Synthetic Garden moves.
    const options = { currency: 'USD', through, today: C_TODAY, categoryParts: C_PARTS, splitIds: new Set(C_PARTS.keys()) };
    const classified = (links?: CardOrderLinks) => classifyCardSpending(C_ROWS, { ...options, orderLinks: links });
    const octoberBefore = cardSpendingWindow(classified(), OCTOBER);
    const octoberAfter = cardSpendingWindow(classified(C_LINKS), OCTOBER);
    // C's report on main 5feaa93f, line for line.
    assert.deepEqual(lines(octoberBefore), [['Dining', 800, 0, 800], ['Home', 4_000, 0, 4_000], ['Shopping', -250, -250, 0],
      ['Synthetic Garden', 0, 470, -470], ['Synthetic Kitchen', -660, -220, -440]]);
    // The rule: order 2's credit is all Synthetic Kitchen's everyday spending, and order 3's refund, set against its own
    // charge for 617.50, is apportioned over its two categories by largest remainder (318.71 and 298.79).
    assert.deepEqual(lines(octoberAfter), [['Dining', 800, 0, 800], ['Home', 4_000, 0, 4_000], ['Shopping', -250, -250, 0],
      ['Synthetic Garden', 0, 32_000 - 31_871, -(32_000 - 31_871)], ['Synthetic Kitchen', -660, 30_000 - 29_879, -660 - (30_000 - 29_879)]]);
    assert.deepEqual(fixedFigures(octoberAfter), fixedFigures(octoberBefore));
    for (const [window, label] of [[octoberBefore, 'before'], [octoberAfter, 'after']] as const) {
      assert.deepEqual([window.spendingMinor, window.creditsMinor, window.oneOffMinor, window.everydayMinor], [3_890, -63_910, 0, 3_890], label);
      assert.deepEqual([window.oneOffs.grossMinor, window.oneOffs.refundsMinor], [62_000, -62_000], label);
      assert.deepEqual(window.oneOffs.items.map((item) => [item.id, item.refundedMinor]), [['c-order3', 62_000]], label);
      expectWindowAddsUp(window, `C's October ${label}`);
    }
    // September has no large purchase: the same either way.
    assert.deepEqual(cardSpendingWindow(classified(C_LINKS), SEPTEMBER), cardSpendingWindow(classified(), SEPTEMBER));
    assert.deepEqual(lines(cardSpendingWindow(classified(C_LINKS), SEPTEMBER)),
      [['Synthetic Garden', 440, 0, 440], ['Synthetic Kitchen', 660, 0, 660], ['Synthetic Toys', 330, 0, 330]]);
    // A category filter reads each category's portions, with every part for the refunds' shares: each category's
    // one-offs are the whole view's line.
    for (const line of octoberAfter.categories) {
      const portions = new Map<string, CardCategoryPart[]>();
      const shown = C_ROWS.flatMap((row) => {
        const parts = C_PARTS.get(row.id);
        if (!parts) return effectiveCardCategory(row) === line.category ? [row] : [];
        const portion = sum(parts.filter((part) => part.category === line.category).map((part) => part.amountMinor));
        if (portion === 0) return [];
        portions.set(row.id, [{ category: line.category, amountMinor: portion, categorySource: 'original-effective', classification: 'source' }]);
        return [{ ...row, amountMinor: portion }];
      });
      const filtered = cardSpendingWindow(classifyCardSpending(shown, {
        ...options, categoryParts: portions, fullParts: C_PARTS, detectionRows: C_ROWS, orderLinks: C_LINKS,
      }), OCTOBER);
      assert.deepEqual([filtered.spendingMinor, filtered.oneOffMinor, filtered.everydayMinor], [line.amountMinor, line.oneOffMinor, line.everydayMinor], line.category);
    }
    // The insights: the large charge was returned in full either way, so no large purchase is reported, and October is
    // the same everyday spending.
    for (const links of [undefined, C_LINKS]) {
      const insights = computeCardInsights(C_ROWS, { month: '2026-10', today: C_TODAY, currency: 'USD', categoryParts: C_PARTS, orderLinks: links });
      assert.equal(insights.largePurchases, null);
      assert.deepEqual([insights.spendingMinor, insights.baselineMinor], [3_890, 1_430]);
    }
  });

  it('a partial return: the large purchase costs what its own order\'s credits and unlinked credits leave', () => {
    // C's scenario without order 3's full refund: the large charge is returned only in part.
    const rows = C_ROWS.filter((row) => row.id !== 'c-order3-refund');
    const options = { month: '2026-10', today: C_TODAY, currency: 'USD', categoryParts: C_PARTS };
    const before = computeCardInsights(rows, options);
    const after = computeCardInsights(rows, { ...options, orderLinks: C_LINKS });
    const large = (insights: typeof before) => insights.largePurchases && {
      count: insights.largePurchases.count, totalMinor: insights.largePurchases.totalMinor, coreMinor: insights.largePurchases.coreMinor,
      baselineCoreMinor: insights.largePurchases.baselineCoreMinor, share: insights.largePurchases.share,
      items: insights.largePurchases.items.map((item) => [item.id, item.amountMinor, item.refundedMinor]),
    };
    // October: 65,890 spent. Before, order 2's 6.60 credit lowered the large purchase; now it is everyday spending.
    assert.deepEqual(large(before), {
      count: 1, totalMinor: 61_090, coreMinor: 4_800, baselineCoreMinor: 1_430, share: 61_090 / 65_890, items: [['c-order3', 61_090, 910]],
    });
    assert.deepEqual(large(after), {
      count: 1, totalMinor: 61_750, coreMinor: 4_140, baselineCoreMinor: 1_430, share: 61_750 / 65_890, items: [['c-order3', 61_750, 250]],
    });
    for (const insights of [before, after]) assert.deepEqual([insights.spendingMinor, insights.baselineMinor], [65_890, 1_430]);
    // The overview and the trend: the same categories and totals; the one-offs and everyday spending move by 6.60.
    const classify = (links?: CardOrderLinks) => classifyCardSpending(rows, {
      currency: 'USD', through: OCTOBER.to, today: C_TODAY, categoryParts: C_PARTS, splitIds: new Set(C_PARTS.keys()), orderLinks: links,
    });
    const windowBefore = cardSpendingWindow(classify(), OCTOBER);
    const windowAfter = cardSpendingWindow(classify(C_LINKS), OCTOBER);
    assert.deepEqual([windowBefore.oneOffMinor, windowBefore.everydayMinor, windowBefore.oneOffs.refundsMinor], [61_090, 4_800, -910]);
    assert.deepEqual([windowAfter.oneOffMinor, windowAfter.everydayMinor, windowAfter.oneOffs.refundsMinor], [61_750, 4_140, -250]);
    assert.deepEqual(windowAfter.oneOffs.items.map((item) => [item.id, item.amountMinor, item.refundedMinor]), [['c-order3', 62_000, 250]]);
    assert.deepEqual(lines(windowBefore).filter(([category]) => String(category).startsWith('Synthetic Kitchen')), [['Synthetic Kitchen', 29_340, 29_340, 0]]);
    assert.deepEqual(lines(windowAfter).filter(([category]) => String(category).startsWith('Synthetic Kitchen')), [['Synthetic Kitchen', 29_340, 30_000, -660]]);
    assert.deepEqual(fixedFigures(windowAfter), fixedFigures(windowBefore));
    expectWindowAddsUp(windowBefore, 'before');
    expectWindowAddsUp(windowAfter, 'after');
    const trend = (links?: CardOrderLinks) => cardSpendingTrend(classify(links), ['2026-09', '2026-10'])
      .map((month) => [month.month, month.spendingMinor, month.oneOffMinor, month.everydayMinor]);
    assert.deepEqual(trend(), [['2026-09', 1_430, 0, 1_430], ['2026-10', 65_890, 61_090, 4_800]]);
    assert.deepEqual(trend(C_LINKS), [['2026-09', 1_430, 0, 1_430], ['2026-10', 65_890, 61_750, 4_140]]);
  });

  it('Root\'s three branches, under every condition of the merchant rule: decisive and the same order, decisive and another, undecided', () => {
    const { rows, links } = edgeLedger();
    const household = orderLinks(links, rows);
    // Decisive: orders q, x and p, x (its charge on card B), v, p and v. Undecided: order y, whose charge is linked to no
    // card row. Unlinked: no order at all.
    assert.deepEqual(['q-credit', 'xp-credit', 'x-credit', 'v-credit', 'pv-credit', 'y-credit', 'unlinked-credit'].map((id) => decisive(household, id)),
      [true, true, true, true, true, false, false]);
    // Refunds of any date go with large purchases; the threshold is as of March 31, a year with all 400 small purchases.
    const through = '2026-03-31';
    const before = splitLargeCardPurchases(rows, { currency: 'USD', through });
    const after = splitLargeCardPurchases(rows, { currency: 'USD', through, orderLinks: household });
    assert.equal(after.thresholdMinor, 50_000);
    assert.deepEqual(after.large.map((item) => item.row.id), ['p-charge', 'u-charge', 'v-charge']);
    // Before: every credit at the merchant on the card within 90 days, oldest purchase first, whatever its order.
    assert.deepEqual(refunded(before), [['p-charge', 300_000, 0], ['u-charge', 165_000, 85_000], ['v-charge', 0, 200_000]]);
    assert.deepEqual(setAgainst(before), [['pv-credit', 300_000], ['q-credit', 10_000], ['unlinked-credit', 40_000], ['v-credit', 50_000],
      ['x-credit', 30_000], ['xp-credit', 20_000], ['y-credit', 15_000]]);
    // After:
    // - decisive, the same order: p-charge takes the credits for q and for x and p, and 2,150.00 of the one for p and v;
    //   v-charge takes its own credit and the 850.00 left of the one for p and v;
    // - decisive, another order: order x's credit goes with no large purchase (its charge is on card B), and the charge
    //   linked to no order takes no decisive credit;
    // - undecided: order y's credit goes by the merchant rule, to p-charge, as the unlinked one does.
    // Another card, another merchant, before the charge or more than 90 days after it: never, links or not.
    assert.deepEqual(refunded(after), [['p-charge', 300_000, 0], ['u-charge', 0, 250_000], ['v-charge', 135_000, 65_000]]);
    assert.deepEqual(setAgainst(after), [['pv-credit', 300_000], ['q-credit', 10_000], ['unlinked-credit', 40_000], ['v-credit', 50_000],
      ['xp-credit', 20_000], ['y-credit', 15_000]]);
    // The insights list the large purchases by what they cost: both their amounts and their order change.
    const insights = (links?: CardOrderLinks) => computeCardInsights(rows, { month: '2026-03', today: '2026-03-31', currency: 'USD', orderLinks: links })
      .largePurchases?.items.map((item) => [item.id, item.amountMinor, item.refundedMinor]);
    assert.deepEqual(insights(), [['v-charge', 200_000, 0], ['u-charge', 85_000, 165_000]]);
    assert.deepEqual(insights(household), [['u-charge', 250_000, 0], ['v-charge', 65_000, 135_000]]);
  });

  it('decides a link from the household\'s links: an order\'s charge outside the rows a split is given keeps its credit decisive', () => {
    const { rows, links } = edgeLedger();
    // Order w: charged long before a window's rows begin, with a credit next to the large purchases.
    const all = [...rows, edgeRow('w-charge', '2025-01-10', 3_000), edgeRow('w-credit', '2026-03-10', -12_000)];
    const allLinks = new Map([...links, ['w-charge', ['order-w']], ['w-credit', ['order-w']]]);
    const household = orderLinks(allLinks, all);
    const through = '2026-03-31';
    const whole = splitLargeCardPurchases(all, { currency: 'USD', through, orderLinks: household });
    // Neither order x's credit (its charge on card B) nor order w's (its charge a year before) goes with a large purchase.
    assert.deepEqual(refunded(whole), [['p-charge', 300_000, 0], ['u-charge', 0, 250_000], ['v-charge', 135_000, 65_000]]);
    const views: Array<[string, SyntheticCardRow[], string]> = [
      ['card A only', all.filter((row) => row.cardAccountId === CARD_A), 'x-credit'],
      ['from April 2025', all.filter((row) => row.transactionDate >= '2025-04-01'), 'w-credit'],
    ];
    for (const [label, view, credit] of views) {
      const ids = new Set(view.map((row) => row.id));
      const charges = (allLinks.get(credit) ?? []).flatMap((order) => household.chargeIdsOf(order) ?? []);
      assert.ok(charges.length > 0 && charges.every((id) => !ids.has(id)), `${label}: ${credit}'s order is charged outside the view`);
      // The view's own split: the same as the household's for every row in it.
      const split = splitLargeCardPurchases(view, { currency: 'USD', through, orderLinks: household });
      assert.deepEqual(refunded(split), refunded(whole), label);
      assert.deepEqual(setAgainst(split), setAgainst(whole).filter(([id]) => ids.has(id)), label);
      // Decided from the rows given instead, the order would look undecided: C's defect, back in exactly these views.
      const local = splitLargeCardPurchases(view, { currency: 'USD', through, orderLinks: orderLinks(allLinks, view) });
      assert.ok(local.refundsSetAgainstLarge.has(credit), `${label}: decided from the view's rows, ${credit} would offset a large purchase`);
    }
  });

  it('answers exactly as before when no decisive credit is linked to an order other than the large purchases it could offset', () => {
    let withRefundsSetAgainst = 0;
    for (let seed = 1; seed <= 8; seed += 1) {
      const ledger = syntheticSpendingLedger({ seed, months: 20, foreign: seed % 4 === 0 });
      const { rows } = ledger;
      const mapped = (ordersOf: (row: SyntheticCardRow) => string[] | undefined) => orderLinks(new Map(rows.flatMap((row) => {
        const orders = ordersOf(row);
        return orders ? [[row.id, orders] as const] : [];
      })), rows);
      const variants: Array<[string, CardOrderLinks]> = [
        ['no link answered', { orderRefsOf: () => undefined, chargeIdsOf: () => undefined }],
        ['empty links', { orderRefsOf: () => [], chargeIdsOf: () => [] }],
        ['only purchases linked', mapped((row) => (row.kind === 'purchase' ? [`order-${row.id}`] : undefined))],
        // Undecided: credits linked to orders whose charges are linked to no card row go by the merchant rule.
        ['credits linked to orders with no linked charge', mapped((row) => (row.amountMinor < 0 ? [`order-held-${row.id}`] : undefined))],
        ['charges linked, credits to orders with no linked charge', mapped((row) => [row.amountMinor > 0 ? `order-${row.id}` : `order-held-${row.id}`])],
        // The merchant rule needs the same card: one order per card is shared by every pair it allows.
        ['one order per card', mapped((row) => [`order-${row.cardAccountId}`])],
        ['several, one shared per card', mapped((row) => [`order-${row.id}`, `order-${row.cardAccountId}`])],
      ];
      const today = `${ledger.lastMonth}-20`;
      const through = `${ledger.lastMonth}-${daysIn(ledger.lastMonth)}`;
      const current = monthRange(addMonths(ledger.lastMonth, -1));
      const baseline = monthRange(addMonths(ledger.lastMonth, -13));
      const year = { from: `${addMonths(ledger.lastMonth, -12)}-01`, to: current.to, baseline: { from: `${addMonths(ledger.lastMonth, -19)}-01`, to: `${addMonths(ledger.lastMonth, -13)}-28` } };
      const months = Array.from({ length: 12 }, (_, index) => addMonths(ledger.lastMonth, index - 11));
      const answers = (links?: CardOrderLinks) => ({
        split: splitLargeCardPurchases(rows, { currency: 'USD', through, orderLinks: links }),
        // The current month (with its pace), and a year against the one before.
        month: computeCardInsights(rows, { month: ledger.lastMonth, today, currency: 'USD', orderLinks: links }),
        year: computeCardInsights(rows, { month: ledger.lastMonth, today, currency: 'USD', period: year, orderLinks: links }),
        comparison: compareCardSpending(rows, { currency: 'USD', through: current.to, today, current, baseline, orderLinks: links }),
        trend: cardSpendingTrend(classifyCardSpending(rows, { currency: 'USD', through, today, orderLinks: links }), months),
      });
      const plain = answers();
      if (plain.split.refundsSetAgainstLarge.size > 0) withRefundsSetAgainst += 1;
      for (const [name, links] of variants) assert.deepEqual(answers(links), plain, `seed ${seed}: ${name}`);
    }
    assert.ok(withRefundsSetAgainst >= 4, `${withRefundsSetAgainst} of 8 ledgers set refunds against large purchases`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Generated ledgers with order links.
// ---------------------------------------------------------------------------------------------------------------------

/** The generated ledgers' large-purchase merchants (__fixtures__/syntheticSpendingLedger.ts). */
const LARGE_MERCHANTS = /^(?:SAMPLEWAREHOUSE\.COM|SAMPLE ELECTRONICS STORE|SAMPLE AIRLINE TICKETS)/;

/**
 * A generated ledger with more credits at its large purchases' merchants: one to three for most of them, on the same
 * card at the same merchant, 0 to 99 days after (some beyond 90 days), each for up to 60% of the purchase.
 */
function withCredits(seed: number) {
  const ledger = syntheticSpendingLedger({ seed, months: 20, foreign: seed % 3 === 0 });
  const next = seededRandom(seed * 7_901);
  const rows: SyntheticCardRow[] = [...ledger.rows];
  /** Each added credit's purchase. */
  const purchaseOf = new Map<string, string>();
  for (const row of ledger.rows) {
    if (row.kind !== 'purchase' || row.status !== 'posted' || !LARGE_MERCHANTS.test(row.description) || next() < 0.2) continue;
    for (let n = 1 + Math.floor(next() * 3); n > 0; n -= 1) {
      const credit: SyntheticCardRow = {
        ...row, id: `${row.id}-credit-${n}`, kind: 'refund', userCategory: null, transactionDate: addDays(row.transactionDate, Math.floor(next() * 100)),
        amountMinor: -Math.max(1, Math.floor(row.amountMinor * next() * 0.6)),
      };
      rows.push(credit);
      purchaseOf.set(credit.id, row.id);
    }
  }
  return { ledger, rows, purchaseOf };
}

/**
 * Random links, as the Amazon domain could make them: most purchases at an ordered merchant linked to their own order
 * (some to a second one shared with other purchases); each added credit linked to its purchase's order, to another
 * order, to two, or to none; the generator's own refunds linked to none, to some purchase's order, or to an order no
 * purchase in the ledger has. Of the other orders, the even ones are charged on a card row outside the ledger (another
 * card, or before it begins): decisive; the odd ones, and `order-unseen`, have no linked charge: undecided.
 */
function randomLinks(rows: readonly SyntheticCardRow[], purchaseOf: ReadonlyMap<string, string>, seed: number) {
  const next = seededRandom(seed * 3_571);
  const links = new Map<string, string[]>();
  const orders: string[] = [];
  const any = () => orders[Math.floor(next() * orders.length)];
  for (const row of rows) {
    if (row.kind !== 'purchase' || !(LARGE_MERCHANTS.test(row.description) || row.description.startsWith('SAMPLE MARKETPLACE')) || next() < 0.15) continue;
    const order = `order-${row.id}`;
    links.set(row.id, next() < 0.2 ? [order, `order-shared-${Math.floor(next() * 3)}`] : [order]);
    orders.push(order);
  }
  for (const row of rows) {
    if (row.kind !== 'refund') continue;
    const pick = next();
    const purchase = purchaseOf.get(row.id);
    if (purchase !== undefined) {
      const own = links.get(purchase)?.[0];
      if (pick < 0.35 && own) links.set(row.id, [own]);
      else if (pick < 0.6) links.set(row.id, [`order-elsewhere-${Math.floor(next() * 5)}`]);
      else if (pick < 0.75 && orders.length > 0) links.set(row.id, [any(), `order-elsewhere-${Math.floor(next() * 5)}`]);
    } else if (pick < 0.3 && orders.length > 0) links.set(row.id, [any()]);
    else if (pick < 0.45) links.set(row.id, ['order-unseen']);
  }
  const elsewhere = new Map([0, 2, 4].map((n) => [`order-elsewhere-${n}`, [`charge-elsewhere-${n}`]]));
  return { links, elsewhere };
}

/**
 * Item parts, as a reviewed category source would accept them: the marketplace's rows (an item part and the charge's
 * rest) and the electronics store's purchases and credits (two item parts), adding up to each row to the cent.
 */
function itemParts(rows: readonly SyntheticCardRow[], seed: number): Map<string, CardCategoryPart[]> {
  const next = seededRandom(seed * 7_919);
  const parts = new Map<string, CardCategoryPart[]>();
  for (const row of rows) {
    if (row.status !== 'posted' || row.currency !== 'USD') continue;
    const classification = row.amountMinor < 0 ? 'policy-allocated' as const : 'source' as const;
    if (row.description.startsWith('SAMPLE MARKETPLACE') && next() >= 0.3) {
      const item = Math.trunc(row.amountMinor * (0.4 + next() * 0.5));
      parts.set(row.id, [
        { category: next() < 0.5 ? 'Merchandise & Supplies-Groceries' : 'Merchandise & Supplies-Furnishing', amountMinor: item, categorySource: 'agent-classification', classification },
        { category: row.issuerCategory ?? 'Uncategorized', amountMinor: row.amountMinor - item, categorySource: 'original-effective', classification: 'residual' },
      ]);
    } else if (row.description.startsWith('SAMPLE ELECTRONICS STORE') && next() >= 0.2) {
      const item = Math.trunc(row.amountMinor * (0.5 + next() * 0.4));
      parts.set(row.id, [
        { category: 'Electronics', amountMinor: item, categorySource: 'reviewed-mapping', classification },
        { category: 'Home', amountMinor: row.amountMinor - item, categorySource: 'item-override', classification },
      ]);
    }
  }
  return parts;
}

describe('credits linked to orders on generated ledgers', () => {
  it('sets a decisive credit for another order as if no large purchase could reach it; one for its own, or undecided, as before', () => {
    let foreignOnce = 0;
    let undecidedSet = 0;
    let comparedWindows = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const { ledger, rows } = withCredits(seed);
      const next = seededRandom(seed * 911);
      // Every purchase linked to its card's one order. Each credit: linked to the same order (the charge's, for every
      // large purchase the merchant rule allows it, which are on its card); to an order charged on a row outside the
      // ledger (decisive, another order); to an order with no linked charge (undecided); or to none.
      const links = new Map<string, string[]>();
      const foreign = new Set<string>();
      const undecided = new Set<string>();
      for (const row of rows) {
        if (row.kind === 'purchase') links.set(row.id, [`order-${row.cardAccountId}`]);
        if (row.kind !== 'refund') continue;
        const pick = next();
        if (pick < 0.3) links.set(row.id, [`order-${row.cardAccountId}`]);
        else if (pick < 0.55) {
          links.set(row.id, ['order-foreign']);
          foreign.add(row.id);
        } else if (pick < 0.75) {
          links.set(row.id, ['order-held']);
          undecided.add(row.id);
        }
      }
      const household = orderLinks(links, rows, new Map([['order-foreign', ['charge-elsewhere']]]));
      // The reference: no links, with each decisive credit for another order moved where no purchase is (another card).
      const moved = rows.map((row) => (foreign.has(row.id) ? { ...row, cardAccountId: 'card-syn-elsewhere' } : row));
      const through = `${ledger.lastMonth}-${daysIn(ledger.lastMonth)}`;
      const linked = splitLargeCardPurchases(rows, { currency: 'USD', through, orderLinks: household });
      const reference = splitLargeCardPurchases(moved, { currency: 'USD', through });
      const label = `seed ${seed}`;
      assert.equal(linked.thresholdMinor, reference.thresholdMinor, label);
      assert.deepEqual(setAgainst(linked), setAgainst(reference), label);
      assert.deepEqual(refunded(linked), refunded(reference), label);
      assert.deepEqual(everyday(linked), everyday(reference), label);
      // These credits mattered: without links, the merchant rule set some decisive ones for another order against a
      // large purchase; and some undecided ones still are, by the merchant rule.
      const plain = splitLargeCardPurchases(rows, { currency: 'USD', through });
      foreignOnce += [...foreign].filter((id) => plain.refundsSetAgainstLarge.has(id)).length;
      undecidedSet += [...undecided].filter((id) => linked.refundsSetAgainstLarge.has(id)).length;
      // The overview's comparison and trend, and the insights' figures that read the split, likewise.
      for (const offset of [1, 4, 13]) {
        const current = monthRange(addMonths(ledger.lastMonth, -offset));
        const baseline = monthRange(addMonths(ledger.lastMonth, -offset - 1));
        const today = `${ledger.lastMonth}-15`;
        assert.deepEqual(
          compareCardSpending(rows, { currency: 'USD', through: current.to, today, current, baseline, orderLinks: household }),
          compareCardSpending(moved, { currency: 'USD', through: current.to, today, current, baseline }),
          `${label} ${current.from}`,
        );
        // Moving a credit to another card changes only which duplicates it settles; nothing else the insights say.
        const insights = (input: readonly SyntheticCardRow[], links?: CardOrderLinks) => ({
          ...computeCardInsights(input, { month: current.from.slice(0, 7), today, currency: 'USD', orderLinks: links }), duplicates: [],
        });
        assert.deepEqual(insights(rows, household), insights(moved), `${label} ${current.from}: insights`);
        comparedWindows += 1;
      }
      assert.deepEqual(
        cardSpendingTrend(classifyCardSpending(rows, { currency: 'USD', through, orderLinks: household }), [addMonths(ledger.lastMonth, -2), addMonths(ledger.lastMonth, -1)]),
        cardSpendingTrend(classifyCardSpending(moved, { currency: 'USD', through }), [addMonths(ledger.lastMonth, -2), addMonths(ledger.lastMonth, -1)]),
        `${label}: trend`,
      );
    }
    assert.ok(foreignOnce >= 10, `${foreignOnce} decisive credits for another order were set against a large purchase before`);
    assert.ok(undecidedSet >= 5, `${undecidedSet} undecided credits are set against a large purchase by the merchant rule`);
    assert.equal(comparedWindows, 36);
  });

  it('keeps every identity with random links: totals and categories to the cent, only one-offs and everyday move', () => {
    let decisiveCredits = 0;
    let undecidedCredits = 0;
    let movedSplits = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const { ledger, rows, purchaseOf } = withCredits(seed);
      const { links, elsewhere } = randomLinks(rows, purchaseOf, seed);
      const household = orderLinks(links, rows, elsewhere);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const through = `${ledger.lastMonth}-${daysIn(ledger.lastMonth)}`;
      const split = splitLargeCardPurchases(rows, { currency: 'USD', through, orderLinks: household });
      const plain = splitLargeCardPurchases(rows, { currency: 'USD', through });
      const label = `seed ${seed}`;
      if (JSON.stringify(setAgainst(split)) !== JSON.stringify(setAgainst(plain))) movedSplits += 1;
      // Links never decide what is large: the same threshold and the same purchases.
      assert.equal(split.thresholdMinor, plain.thresholdMinor, label);
      assert.deepEqual(split.large.map((item) => [item.row.id, item.key]), plain.large.map((item) => [item.row.id, item.key]), label);
      // Exact, in any range of days: spending = large purchases − the parts of refunds set against them + everyday.
      const spent = usdSpending(rows);
      for (let offset = 0; offset < 21; offset += 1) {
        for (const length of [1, 2, 3, 12]) {
          const lastMonth = addMonths(ledger.firstMonth, offset + length - 1);
          const range = { from: `${addMonths(ledger.firstMonth, offset)}-01`, to: `${lastMonth}-${daysIn(lastMonth)}` };
          const spending = sum(spent.filter((row) => within(row.transactionDate, range)).map((row) => row.amountMinor));
          const large = sum(split.large.filter((item) => within(item.row.transactionDate, range)).map((item) => item.row.amountMinor));
          const back = sum([...split.refundsSetAgainstLarge].filter(([id]) => within(byId.get(id)!.transactionDate, range)).map(([, minor]) => minor));
          const rest = sum(split.everyday.filter((row) => within(row.transactionDate, range)).map((row) => row.amountMinor));
          assert.equal(large - back + rest, spending, `${label} ${range.from}..${range.to}`);
        }
      }
      // What was set against them adds up both ways; no refund gives more than itself, no purchase gets back more than it cost.
      assert.equal(sum([...split.refundsSetAgainstLarge.values()]), sum(split.large.map((item) => item.refundedMinor)), label);
      for (const [id, minor] of split.refundsSetAgainstLarge) assert.ok(minor > 0 && minor <= -byId.get(id)!.amountMinor, `${label} ${id}`);
      for (const item of split.large) assert.ok(item.refundedMinor >= 0 && item.netMinor >= 0 && item.netMinor === item.row.amountMinor - item.refundedMinor);
      // A credit with a decisive link went only with its orders' charges: same card, at most 90 days before it; at most
      // what they had refunded, and never with none. An undecided one goes by the merchant rule (checked above).
      for (const [id, minor] of split.refundsSetAgainstLarge) {
        const credit = byId.get(id)!;
        const charges = new Set((links.get(id) ?? []).flatMap((order) => household.chargeIdsOf(order) ?? []));
        if (charges.size === 0) {
          if ((links.get(id) ?? []).length > 0) undecidedCredits += 1;
          continue;
        }
        decisiveCredits += 1;
        const reach = split.large.filter((item) => item.row.cardAccountId === credit.cardAccountId
          && dayNumber(credit.transactionDate) - dayNumber(item.row.transactionDate) >= 0
          && dayNumber(credit.transactionDate) - dayNumber(item.row.transactionDate) <= 90
          && charges.has(item.row.id));
        assert.ok(reach.length > 0 && minor <= sum(reach.map((item) => item.refundedMinor)), `${label}: ${id} went with one of its orders' charges`);
      }

      // The overview, with item parts: every window's totals and every category's amount are the same with links or
      // without, and every window, category and merchant line still adds up; its one-offs are the split's, to the cent.
      const parts = itemParts(rows, seed);
      const today = `${ledger.lastMonth}-15`;
      const windows = [1, 4, 13].map((offset) => monthRange(addMonths(ledger.lastMonth, -offset)))
        .concat([{ from: `${addMonths(ledger.lastMonth, -12)}-01`, to: through }]);
      for (const range of windows) {
        const options = { currency: 'USD', through: range.to, today, categoryParts: parts, splitIds: new Set(parts.keys()) };
        const linkedWindow = cardSpendingWindow(classifyCardSpending(rows, { ...options, orderLinks: household }), range);
        const plainWindow = cardSpendingWindow(classifyCardSpending(rows, options), range);
        const where = `${label} ${range.from}..${range.to}`;
        assert.deepEqual(fixedFigures(linkedWindow), fixedFigures(plainWindow), where);
        expectWindowAddsUp(linkedWindow, where);
        const asOf = splitLargeCardPurchases(rows, { currency: 'USD', through: range.to, today, orderLinks: household });
        assert.equal(linkedWindow.oneOffMinor,
          sum(asOf.large.filter((item) => within(item.row.transactionDate, range)).map((item) => item.row.amountMinor))
          - sum([...asOf.refundsSetAgainstLarge].filter(([id]) => within(byId.get(id)!.transactionDate, range)).map(([, minor]) => minor)), where);
        // A category filter reads each category's portions: each category's one-offs are still the whole view's line.
        for (const line of linkedWindow.categories) {
          const portions = new Map<string, CardCategoryPart[]>();
          const shown = rows.flatMap((row) => {
            const rowParts = parts.get(row.id);
            if (!rowParts) return effectiveCardCategory(row) === line.category ? [row] : [];
            const portion = sum(rowParts.filter((part) => part.category === line.category).map((part) => part.amountMinor));
            if (portion === 0) return [];
            portions.set(row.id, [{ category: line.category, amountMinor: portion, categorySource: 'original-effective', classification: 'source' }]);
            return [{ ...row, amountMinor: portion }];
          });
          const filtered = cardSpendingWindow(classifyCardSpending(shown, {
            ...options, categoryParts: portions, fullParts: parts, detectionRows: rows, orderLinks: household,
          }), range);
          expectWindowAddsUp(filtered, `${where} ${line.category}`);
          assert.deepEqual([filtered.spendingMinor, filtered.oneOffMinor, filtered.recurringMinor, filtered.everydayMinor],
            [line.amountMinor, line.oneOffMinor, line.recurringMinor, line.everydayMinor], `${where} ${line.category}`);
        }
      }
      // The trend: the same months to the cent, each split into recurring, one-offs and everyday.
      const months = Array.from({ length: 12 }, (_, index) => addMonths(ledger.lastMonth, index - 11));
      const trend = cardSpendingTrend(classifyCardSpending(rows, { currency: 'USD', through, orderLinks: household }), months);
      const plainTrend = cardSpendingTrend(classifyCardSpending(rows, { currency: 'USD', through }), months);
      assert.deepEqual(trend.map((month) => [month.month, month.spendingMinor, month.count, month.recurringMinor]),
        plainTrend.map((month) => [month.month, month.spendingMinor, month.count, month.recurringMinor]), label);
      for (const month of trend) assert.equal(month.recurringMinor + month.oneOffMinor + month.everydayMinor, month.spendingMinor);

      // The insights report the same split: one threshold, its large purchases net of what was set against them, the
      // period without them; and the same spending.
      for (const month of [addMonths(ledger.lastMonth, -1), addMonths(ledger.lastMonth, -7)]) {
        const period = { ...monthRange(month), baseline: monthRange(addMonths(month, -1)) };
        const insights = computeCardInsights(rows, { month, today: through, currency: 'USD', period, orderLinks: household });
        const plainInsights = computeCardInsights(rows, { month, today: through, currency: 'USD', period });
        const asOf = splitLargeCardPurchases(rows, { currency: 'USD', through: period.to, today: through, orderLinks: household });
        const inPeriod = asOf.large.filter((item) => within(item.row.transactionDate, period) && item.netMinor > 0)
          .sort((a, b) => b.netMinor - a.netMinor || byText(a.row.id, b.row.id));
        assert.deepEqual([insights.spendingMinor, insights.baselineMinor], [plainInsights.spendingMinor, plainInsights.baselineMinor]);
        if (inPeriod.length === 0) {
          assert.equal(insights.largePurchases, null, `${label} ${month}`);
          continue;
        }
        assert.ok(insights.largePurchases);
        assert.equal(insights.largePurchases.totalMinor, sum(inPeriod.map((item) => item.netMinor)));
        assert.equal(insights.largePurchases.coreMinor, sum(asOf.everyday.filter((row) => within(row.transactionDate, period)).map((row) => row.amountMinor)));
        assert.equal(insights.largePurchases.coreMinor + insights.largePurchases.totalMinor,
          insights.spendingMinor - sum(asOf.large.filter((item) => within(item.row.transactionDate, period) && item.netMinor === 0).map((item) => item.row.amountMinor))
          + sum([...asOf.refundsSetAgainstLarge].filter(([id]) => within(byId.get(id)!.transactionDate, period)).map(([, minor]) => minor))
          - sum(inPeriod.map((item) => item.refundedMinor)), `${label} ${month}: the period without its large purchases`);
        assert.deepEqual(insights.largePurchases.items.map((item) => [item.id, item.amountMinor, item.refundedMinor]),
          inPeriod.slice(0, 5).map((item) => [item.row.id, item.netMinor, item.refundedMinor]), `${label} ${month}`);
      }
    }
    assert.ok(decisiveCredits >= 20, `${decisiveCredits} decisive credits set against one of their orders' charges`);
    assert.ok(undecidedCredits >= 5, `${undecidedCredits} undecided credits set against a large purchase by the merchant rule`);
    assert.ok(movedSplits >= 8, `${movedSplits} of 12 ledgers split differently with their links`);
  });

  it('lets owner decisions win: asset purchases and their refunds stay out of the split, links or not', () => {
    // The owner's precious metals (and an owner-filed credit) at a seller where another large purchase is spending.
    const card = 'card-syn-k';
    const rows: SyntheticCardRow[] = [];
    for (let n = 0; n < 400; n += 1) {
      rows.push({ id: `bg-${String(n).padStart(3, '0')}`, cardAccountId: card, transactionDate: addDays('2025-06-01', Math.floor(n * 0.8)),
        status: 'posted', kind: 'purchase', amountMinor: 1_200 + (n % 5) * 300, currency: 'USD', description: 'NORTHWIND GROCER', merchant: null,
        issuerCategory: 'Groceries' });
    }
    const at = (id: string, transactionDate: string, amountMinor: number, userCategory: string | null = null): SyntheticCardRow => ({
      id, cardAccountId: card, transactionDate, status: 'posted', kind: amountMinor < 0 ? 'refund' : 'purchase', amountMinor, currency: 'USD',
      description: 'SAMPLEWAREHOUSE.COM *ONLINE', merchant: null, issuerCategory: 'Merchandise & Supplies-Wholesale Stores', userCategory,
    });
    rows.push(
      at('metals-charge', '2026-05-02', 400_000, 'Precious metals'), // order m, the owner's asset purchase
      at('tv-charge', '2026-05-03', 300_000), // order n
      at('metals-credit', '2026-05-09', -400_000, 'Precious metals'), // order m, filed by the owner too
      at('metals-part-credit', '2026-05-10', -50_000), // order m: a credit for the asset purchase's order, not filed
      at('unlinked-credit', '2026-05-11', -30_000), // linked to none
    );
    const linkMap = new Map([
      ['metals-charge', ['order-m']], ['metals-credit', ['order-m']], ['metals-part-credit', ['order-m']], ['tv-charge', ['order-n']],
    ]);
    const links = orderLinks(linkMap, rows);
    const exclusions = resolveCardSpendingExclusions(rows);
    assert.deepEqual([...exclusions.keys()].sort(), ['metals-charge', 'metals-credit']);
    const before = splitLargeCardPurchases(rows, { currency: 'USD', through: '2026-05-31', exclusions });
    const after = splitLargeCardPurchases(rows, { currency: 'USD', through: '2026-05-31', exclusions, orderLinks: links });
    // The asset purchase is no large purchase and its owner-filed credit no refund of anything, either way. Order m's
    // charge is linked (the owner's asset purchase), so the credit for it is decisive: before links it went with the
    // other large purchase at the seller; with them it is everyday spending.
    assert.deepEqual(refunded(before), [['tv-charge', 80_000, 220_000]]);
    assert.deepEqual(refunded(after), [['tv-charge', 30_000, 270_000]]);
    assert.deepEqual(setAgainst(after), [['unlinked-credit', 30_000]]);
    assert.deepEqual(everyday(after).filter(([id]) => String(id).includes('credit')), [['metals-part-credit', -50_000]]);
    // Had order m's charge been held (linked to no card row), the credit would be undecided: the merchant rule, as before.
    const held = orderLinks(new Map([...linkMap].filter(([id]) => id !== 'metals-charge')), rows);
    assert.deepEqual(splitLargeCardPurchases(rows, { currency: 'USD', through: '2026-05-31', exclusions, orderLinks: held }), before);

    // On generated ledgers with random links, an answer with asset purchases is exactly the answer without their rows.
    for (let seed = 1; seed <= 12; seed += 1) {
      const generated = withCredits(seed);
      const random = randomLinks(generated.rows, generated.purchaseOf, seed);
      const household = orderLinks(random.links, generated.rows, random.elsewhere);
      const ruled = resolveCardSpendingExclusions(generated.rows);
      const kept = generated.rows.filter((row) => !ruled.has(row.id));
      const through = `${generated.ledger.lastMonth}-${daysIn(generated.ledger.lastMonth)}`;
      assert.deepEqual(
        splitLargeCardPurchases(generated.rows, { currency: 'USD', through, exclusions: ruled, orderLinks: household }),
        splitLargeCardPurchases(kept, { currency: 'USD', through, orderLinks: household }),
        `seed ${seed}: split`,
      );
      const options = { month: addMonths(generated.ledger.lastMonth, -1), today: through, currency: 'USD', orderLinks: household };
      assert.deepEqual(computeCardInsights(generated.rows, { ...options, exclusions: ruled }), computeCardInsights(kept, options), `seed ${seed}: insights`);
    }
  });
});
