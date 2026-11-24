import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MetalsClassUnits, MetalsOverview, MetalsPurchase, MetalsPurchases } from '@finance-tracker/shared/metals-api';

import { complete, overviewFixture, oz, partial, purchaseFixture, unknown } from './goldFixtures';
import { dateText, profitFullyKnown, reasonText, signedUsd, usd } from './goldText';
import {
  TOTALS_BEFORE_REWARDS,
  TOTALS_BASIS_ON_THE_WAY_AT_COST,
  TOTALS_BOUGHT_UNVERIFIED,
  TOTALS_COMBINED_NO_SALES,
  TOTALS_COMBINED_UNAVAILABLE,
  TOTALS_ESTIMATE_BASIS,
  TOTALS_ESTIMATE_BASIS_CARRY,
  TOTALS_ESTIMATE_QUALIFIER,
  TOTALS_HELD_INCOMPLETE,
  TOTALS_FIGURES,
  TOTALS_HELD_EXCLUDED,
  TOTALS_HELD_OFF,
  TOTALS_NEEDS_ALL_TIME,
  TOTALS_NO_PRICE_NEEDED,
  TOTALS_NO_SALES,
  TOTALS_NO_SALES_OFF,
  TOTALS_NOT_COVERED,
  TOTALS_COVERAGE_UNVERIFIABLE,
  TOTALS_RESULT_LABEL,
  TOTALS_SALES_BASIS,
  TOTALS_SALES_LABEL,
  TOTALS_SALES_METHOD,
  TOTALS_SALES_METHOD_FUNGIBLE,
  TOTALS_SOLD_UNVERIFIED,
  TOTALS_UNAVAILABLE,
  TOTALS_UNVERIFIED,
  combinedTitle,
  combinedTotals,
  goldTotals,
  metalUnknownText,
  resultLabelOf,
  totalsReadsPurchases,
  totalsResult,
  type GoldCoverageProof,
  type GoldTotalsInput,
} from './goldTotals';

// 5b01e72f's ten synthetic acceptance cases (ruling v1, sha 3c8f494a, §6), each at the page's level: the ledger's own
// tests hold the assignment, allocation and tender rules; these hold that the page reads them once and never makes a
// figure the gates refuse. Synthetic amounts only.

const PROVEN: GoldCoverageProof = { sales: { state: 'complete', gaps: [] }, asOf: { state: 'complete', gaps: [] } };
const UNSERVED = [TOTALS_COVERAGE_UNVERIFIABLE];
const base = overviewFixture();
const purchasesOf = (...purchases: MetalsPurchase[]): MetalsPurchases => ({ installed: true, metal: 'XAU', from: null, to: '2026-11-08', purchases });
const input = (overview: MetalsOverview = overviewFixture(), purchases: MetalsPurchases | null = purchasesOf(purchaseFixture()),
  purchasesError = false): GoldTotalsInput => ({ overview, purchases, purchasesError });
/** A Holdr that doesn't fetch closes. */
const off = (patch: Partial<MetalsOverview> = {}): MetalsOverview => {
  const overview = overviewFixture(patch);
  return { ...overview, price: { ...overview.price, fetching: false } };
};
const withActivity = (overview: MetalsOverview, patch: Partial<MetalsOverview['activity']>): MetalsOverview =>
  ({ ...overview, activity: { ...overview.activity, ...patch } });
const withHoldings = (overview: MetalsOverview, patch: Partial<MetalsOverview['holdings']>): MetalsOverview =>
  ({ ...overview, holdings: { ...overview.holdings, ...patch } });
const units = (patch: Partial<MetalsClassUnits>): MetalsClassUnits => ({
  delivered: 0, awaiting: 0, sold: 0, soldFromDelivered: 0, soldFromAwaiting: 0, unmatched: 0, held: 0, awaitingUnassigned: 0, ...patch,
});
const unmatchedSale = {
  ...base.activity.sold,
  unmatched: { units: 1, netMinor: 245_000, reasons: [{ reason: 'no-recorded-purchase' as const, units: 1, netMinor: 245_000 }] },
};
const PRICE_NOTE = `Estimated using gold spot · CNBC close, ${dateText('2026-11-06')}. Not a guaranteed sale price.`;
/** A metal with stock and no sale recorded. */
const withoutSales = (overview: MetalsOverview): MetalsOverview => withActivity(overview, {
  sold: { lines: 0, units: 0, troyOz: complete(oz('0/1', '0.000')), grossMinor: complete(0), feesMinor: complete(0), netMinor: complete(0), unmatched: { units: 0, netMinor: 0, reasons: [] } },
  profit: { valueMinor: complete(0), coverage: { basis: 'troy-oz', known: oz('0/1', '0.000'), total: oz('0/1', '0.000'), unknownContentLines: 0 } },
});

test('case 1: every sale known and the history proven complete: the realized result is the cycles\' sum, whatever the price', () => {
  assert.deepEqual(totalsResult(input(off()), PROVEN), {
    kind: 'sales', valueMinor: 45_000, figure: signedUsd(45_000),
    lines: [TOTALS_SALES_BASIS, TOTALS_SALES_METHOD, TOTALS_HELD_OFF, TOTALS_BEFORE_REWARDS],
  });
  // No usable close: the same realized result; holdings said not valued, never a number.
  const noPrice = overviewFixture({ price: { ...base.price, closeDate: null, close: null } });
  const result = totalsResult(input(noPrice), PROVEN);
  assert.equal(result.kind, 'sales');
  assert.equal(result.kind === 'sales' && result.valueMinor, 45_000);
  assert.match(result.lines.join(' '), /Holdings are not valued: no usable CNBC close for gold is stored yet/);
  // Values shown: that result plus the delivered holdings' gain, at the dated close.
  assert.deepEqual(totalsResult(input(), PROVEN), {
    kind: 'estimate', valueMinor: 45_000 + 130_080, figure: signedUsd(175_080),
    lines: [TOTALS_ESTIMATE_QUALIFIER, TOTALS_ESTIMATE_BASIS, PRICE_NOTE, TOTALS_BEFORE_REWARDS],
  });
});

test('case 2: one sale not fully known (unmatched, unknown content, incomplete cost): no headline figure, never a partial one', () => {
  const unmatched = withActivity(off(), {
    sold: unmatchedSale,
    profit: { valueMinor: unknown(['unmatched-sales', 1]), coverage: { basis: 'troy-oz', known: oz('0/1', '0.000'), total: oz('1/1', '1.000'), unknownContentLines: 0 } },
  });
  const notCovered = totalsResult(input(unmatched), PROVEN);
  assert.equal(notCovered.kind, 'unavailable');
  assert.equal(notCovered.kind === 'unavailable' && notCovered.title, TOTALS_NOT_COVERED);
  assert.ok(!('figure' in notCovered));
  const contentHeld = withActivity(off(), {
    profit: { valueMinor: unknown(['content-unknown', 1]), coverage: { basis: 'sale-lines', known: 0, total: 1, unknownContentLines: 1 } },
  });
  assert.deepEqual(totalsResult(input(contentHeld), PROVEN), {
    kind: 'unavailable', title: TOTALS_UNAVAILABLE, action: 'review', lead: reasonText({ code: 'content-unknown', records: 1 }, 'XAU'),
    lines: [reasonText({ code: 'content-unknown', records: 1 }, 'XAU'), 'Known for 0 of 1 sale line · 1 has unknown content.'],
  });
  const costIncomplete = withActivity(off(), { profit: { ...base.activity.profit, valueMinor: partial(45_000, ['cost-unattributed', 1]) } });
  assert.deepEqual(totalsResult(input(costIncomplete), PROVEN), {
    kind: 'unavailable', title: TOTALS_UNAVAILABLE, action: 'review', lead: reasonText({ code: 'cost-unattributed', records: 1 }, 'XAU'),
    lines: [reasonText({ code: 'cost-unattributed', records: 1 }, 'XAU')],
  });
});

test('case 3: nothing unmatched, but the history isn\'t proven complete: no figure, and Bought and Sold say they\'re recorded so far', () => {
  const gap: GoldCoverageProof = {
    sales: { state: 'incomplete', gaps: ['Costco records captured but not imported'] },
    asOf: { state: 'incomplete', gaps: ['Costco records captured but not imported'] },
  };
  assert.deepEqual(totalsResult(input(off()), gap), {
    kind: 'unavailable', title: TOTALS_UNAVAILABLE, action: 'coverage', lead: 'Costco records captured but not imported',
    lines: ['Costco records captured but not imported'],
  });
  // No proof served (G3's coverage proof isn't there yet): unavailable, nothing presumed about other dealers, and the
  // absence of reasons never taken as proof.
  assert.deepEqual(totalsResult(input(off()), null),
    { kind: 'unavailable', title: TOTALS_UNAVAILABLE, action: 'coverage', lead: TOTALS_COVERAGE_UNVERIFIABLE, lines: UNSERVED });
  const totals = goldTotals(input(off()), null);
  assert.deepEqual(totals.bought.limits, [TOTALS_BOUGHT_UNVERIFIED]);
  assert.deepEqual(totals.sold.limits, [TOTALS_SOLD_UNVERIFIED]);
  assert.equal(totals.resultLabel, null);
  assert.deepEqual(goldTotals(input(off()), PROVEN).bought.limits, []);
  // A proof that couldn't be computed is never complete.
  const unavailable: GoldCoverageProof = { sales: { state: 'unavailable', gaps: [] }, asOf: { state: 'unavailable', gaps: [] } };
  assert.deepEqual(totalsResult(input(off()), unavailable).lines, UNSERVED);
  // Incomplete with no gap in words (never served so, but never taken as proven): the general line.
  const unnamed: GoldCoverageProof = { sales: { state: 'incomplete', gaps: [] }, asOf: { state: 'incomplete', gaps: [] } };
  assert.deepEqual(totalsResult(input(off()), unnamed).lines, [TOTALS_UNVERIFIED]);
  // History proven to the last sale but not since: the realized result shows; what is held isn't valued.
  const sinceLastSale: GoldCoverageProof = { sales: PROVEN.sales, asOf: { state: 'incomplete', gaps: ['Walmart orders after Jun 2, 2026 aren’t captured.'] } };
  assert.deepEqual(totalsResult(input(), sinceLastSale), {
    kind: 'sales', valueMinor: 45_000, figure: signedUsd(45_000),
    lines: [TOTALS_SALES_BASIS, TOTALS_SALES_METHOD, 'Holdings are not included in this result.', 'Walmart orders after Jun 2, 2026 aren’t captured.', TOTALS_BEFORE_REWARDS],
  });
});

test('case 4: a surplus of the metal\'s ounces in another class doesn\'t cure a sale with no recorded purchase', () => {
  // 3.000 troy oz of bars bought, 1.000 sold as a coin with no coin purchase: the ledger's class leaves it unmatched.
  const mismatch = withActivity(off(), {
    sold: unmatchedSale,
    profit: { valueMinor: unknown(['unmatched-sales', 1]), coverage: { basis: 'troy-oz', known: oz('0/1', '0.000'), total: oz('1/1', '1.000'), unknownContentLines: 0 } },
  });
  assert.equal(mismatch.activity.bought.troyOz.value?.display, '3.000');
  const result = totalsResult(input(mismatch), PROVEN);
  assert.equal(result.kind === 'unavailable' && result.title, TOTALS_NOT_COVERED);
});

test('case 5: a sale from stock on the way keeps its cost; an unassigned unit on the way is carried at cost, never a loss', () => {
  // Two ordered, none delivered; one sold from them (S_A), one on the way unassigned; nothing delivered is held.
  const onTheWay = withHoldings(overviewFixture(), {
    troyOz: complete(oz('0/1', '0.000')), costMinor: complete(0), valueMinor: complete(0), gainMinor: complete(0),
    units: units({ awaiting: 2, sold: 1, soldFromAwaiting: 1, awaitingUnassigned: 1 }),
  });
  assert.deepEqual(totalsResult(input(onTheWay), PROVEN), {
    kind: 'estimate', valueMinor: 45_000, figure: signedUsd(45_000),
    lines: [TOTALS_ESTIMATE_QUALIFIER, TOTALS_ESTIMATE_BASIS_CARRY, '1 unit on the way counts at what you paid until delivered.', PRICE_NOTE, TOTALS_BEFORE_REWARDS],
  });
  // Delivered: the unit moves into held valuation once; the basis changes, the realized result doesn't.
  const delivered = withHoldings(overviewFixture(), {
    troyOz: complete(oz('1/1', '1.000')), costMinor: complete(200_000), valueMinor: complete(265_040), gainMinor: complete(65_040),
    units: units({ delivered: 1, awaiting: 1, sold: 1, soldFromAwaiting: 1, held: 1 }),
  });
  assert.deepEqual(totalsResult(input(delivered), PROVEN), {
    kind: 'estimate', valueMinor: 45_000 + 65_040, figure: signedUsd(110_040),
    lines: [TOTALS_ESTIMATE_QUALIFIER, TOTALS_ESTIMATE_BASIS, PRICE_NOTE, TOTALS_BEFORE_REWARDS],
  });
});

test('case 6: card and Shop Card, or Shop Card alone: Bought is the served all-in cost, once; tenders are never added', () => {
  const split = purchaseFixture({ funding: [{ kind: 'card', network: 'visa', amountMinor: 150_000 }, { kind: 'shop-card', network: 'unknown', amountMinor: 50_000 }] });
  const shopCardOnly = purchaseFixture({ funding: [{ kind: 'shop-card', network: 'unknown', amountMinor: 200_000 }], cardEvidence: 'none', cards: [] });
  for (const purchases of [purchasesOf(split), purchasesOf(shopCardOnly)]) {
    const totals = goldTotals(input(overviewFixture(), purchases), PROVEN);
    assert.equal(totals.bought.figure, usd(600_000));
    assert.equal(totals.result.kind === 'estimate' && totals.result.valueMinor, 175_080);
  }
});

test('case 7: a sale\'s net proceeds count once, by the day agreed; payouts (an advance, a pending balance) never enter the totals', () => {
  const pending = withActivity(overviewFixture(), { payouts: { count: 1, amountMinor: complete(100_000), mixedMetal: { count: 0, amountMinor: complete(0) } } });
  const totals = goldTotals(input(pending), PROVEN);
  assert.equal(totals.sold.figure, usd(245_000));
  assert.equal(totals.sold.sub, '1.000 troy oz · 1 recorded sale · proceeds after fees');
  assert.equal(totals.result.kind === 'estimate' && totals.result.valueMinor, 175_080);
});

test('case 8: cancelled, returned or refunded purchases block the estimate that includes holdings; held records block any figure', () => {
  const cancelled = purchaseFixture({ key: 'costco-line-cccc', units: { ordered: 1, cancelled: 1, returned: 0, delivered: 0, awaiting: 0 }, delivery: { state: 'cancelled', date: null } });
  const returned = purchaseFixture({
    key: 'costco-line-dddd', units: { ordered: 1, cancelled: 0, returned: 1, delivered: 0, awaiting: 0 }, delivery: { state: 'returned', date: '2026-04-01' },
    refunds: [{ amountMinor: -200_000, date: '2026-04-02' }],
  });
  const result = totalsResult(input(overviewFixture(), purchasesOf(purchaseFixture(), cancelled, returned)), PROVEN);
  assert.deepEqual(result, {
    kind: 'sales', valueMinor: 45_000, figure: signedUsd(45_000),
    lines: [TOTALS_SALES_BASIS, TOTALS_SALES_METHOD, 'Holdings are not included in this result: 2 cancelled or returned purchases: refunds aren’t reconciled here.', TOTALS_BEFORE_REWARDS],
  });
  // Prices off: the realized result doesn't depend on them.
  assert.equal(totalsResult(input(off(), purchasesOf(cancelled, returned)), PROVEN).kind, 'sales');
  // A purchases read that failed is said, never taken as none.
  const failed = totalsResult(input(overviewFixture(), null, true), PROVEN);
  assert.match(failed.lines.join(' '), /purchases couldn’t be read, so cancelled and returned ones can’t be checked/);
  // An open held record (an unexplained refund, an unlinked return) on the realized result: no figure.
  const held = withActivity(off(), { profit: { ...base.activity.profit, valueMinor: partial(45_000, ['source-held', 1]) } });
  assert.deepEqual(totalsResult(input(held), PROVEN), {
    kind: 'unavailable', title: TOTALS_UNAVAILABLE, action: 'review', lead: reasonText({ code: 'source-held', records: 1 }, 'XAU'),
    lines: [reasonText({ code: 'source-held', records: 1 }, 'XAU')],
  });
});

test('a figure the estimate needs that isn\'t complete leaves holdings out even when it gives no reason (fail closed; G1d, PR-R)', () => {
  // Never served so (a partial or unknown measure carries its reasons), but never taken as whole: the realized result
  // shows, and holdings are left out with Astra's general line, said only when no specific reason exists.
  assert.equal(TOTALS_HELD_INCOMPLETE, 'Holdings are not included in this result because required information is incomplete.');
  const withoutHoldings = {
    kind: 'sales', valueMinor: 45_000, figure: signedUsd(45_000),
    lines: [TOTALS_SALES_BASIS, TOTALS_SALES_METHOD, TOTALS_HELD_INCOMPLETE, TOTALS_BEFORE_REWARDS],
  };
  assert.deepEqual(totalsResult(input(withHoldings(overviewFixture(), { gainMinor: partial(130_080) })), PROVEN), withoutHoldings);
  assert.deepEqual(totalsResult(input(withHoldings(overviewFixture(), { costMinor: unknown<number>() })), PROVEN), withoutHoldings);
  assert.deepEqual(totalsResult(input(withActivity(overviewFixture(), { bought: { ...base.activity.bought, costMinor: partial(200_000) } })), PROVEN),
    withoutHoldings);
  // A figure that gives its reason says that reason instead, once.
  const stale = withHoldings(overviewFixture(), { gainMinor: partial(130_080, ['price-stale', 1]) });
  assert.ok(!totalsResult(input(stale), PROVEN).lines.includes(TOTALS_HELD_INCOMPLETE));
  // A reasonless figure beside a specific reason: only the specific reason is said.
  const both = withHoldings(overviewFixture(), { gainMinor: partial(130_080), costMinor: partial(400_000, ['price-stale', 1]) });
  const lines = totalsResult(input(both), PROVEN).lines;
  assert.ok(!lines.includes(TOTALS_HELD_INCOMPLETE), lines.join(' | '));
  assert.ok(lines.some((line) => line.startsWith('Holdings are not included in this result: ')), lines.join(' | '));
});

test('case 9: all-time reads only; the metals together add like with like, in exact cents, or say why not', () => {
  // Period activity with all-time holdings is never a total.
  assert.deepEqual(totalsResult(input(withActivity(overviewFixture(), { from: '2026-05-09' })), PROVEN),
    { kind: 'unavailable', title: TOTALS_UNAVAILABLE, action: 'review', lead: TOTALS_NEEDS_ALL_TIME, lines: [TOTALS_NEEDS_ALL_TIME] });
  const gold = input(off());
  const silver = input(off({ metal: 'XAG' }));
  const both = combinedTotals([gold, silver].map((item) => ({ input: item, totals: goldTotals(item, PROVEN) })));
  assert.deepEqual(both && { heading: both.heading, bought: both.bought.figure, sold: both.sold.figure, label: both.resultLabel, result: both.result }, {
    heading: 'Gold and silver combined', bought: usd(1_200_000), sold: usd(490_000), label: TOTALS_SALES_LABEL,
    result: { kind: 'sales', valueMinor: 90_000, figure: signedUsd(90_000), lines: [TOTALS_SALES_BASIS, TOTALS_HELD_EXCLUDED, TOTALS_BEFORE_REWARDS] },
  });
  // One metal's result unknown: no combined figure.
  const silverUnknown = input(withActivity(off({ metal: 'XAG' }), { sold: unmatchedSale, profit: { ...base.activity.profit, valueMinor: unknown(['unmatched-sales', 1]) } }));
  const refused = combinedTotals([gold, silverUnknown].map((item) => ({ input: item, totals: goldTotals(item, PROVEN) })));
  assert.deepEqual(refused?.result, {
    kind: 'unavailable', title: TOTALS_COMBINED_UNAVAILABLE, action: 'coverage', lead: 'Silver’s profit or loss is unavailable.',
    lines: ['Silver’s profit or loss is unavailable.'],
  });
  // One metal includes holdings, the other can't: never added.
  const goldOn = input(overviewFixture());
  const mixed = combinedTotals([goldOn, silver].map((item) => ({ input: item, totals: goldTotals(item, PROVEN) })));
  assert.deepEqual(mixed?.result.lines, ['One metal’s figure includes what you hold and another’s doesn’t, so they can’t be added.']);
  // Fewer than two metals: no combined panel.
  assert.equal(combinedTotals([{ input: gold, totals: goldTotals(gold, PROVEN) }]), null);
});

test('case 10: unknown holdings or price stay unknown; none held needs no price; only evidence names a gap; an unknown metal blocks totals', () => {
  // A stale close: the holdings' gain is partial, so the estimate isn't shown; the realized result is.
  const stale = withHoldings(overviewFixture({ price: { ...base.price, stale: true } }), {
    valueMinor: partial(530_080, ['price-stale', 1]), gainMinor: partial(130_080, ['price-stale', 1]),
  });
  assert.deepEqual(totalsResult(input(stale), PROVEN), {
    kind: 'sales', valueMinor: 45_000, figure: signedUsd(45_000),
    lines: [TOTALS_SALES_BASIS, TOTALS_SALES_METHOD, 'Holdings are not included in this result: the latest gold close is more than 5 weekdays old.', TOTALS_BEFORE_REWARDS],
  });
  // Nothing delivered is held (proven): its value is zero without a price.
  const noneHeld = withHoldings(stale, {
    troyOz: complete(oz('0/1', '0.000')), costMinor: complete(0), units: units({ delivered: 1, sold: 1, soldFromDelivered: 1 }),
  });
  assert.equal(totalsResult(input(noneHeld), PROVEN).kind, 'estimate');
  // With no proof, nothing names a source or an account: the served gaps alone may.
  const unproven = goldTotals(input(off()), null);
  assert.doesNotMatch(JSON.stringify(unproven), /Costco|Walmart|CollectPure|membership/);
  // A purchase or sale naming more than one metal: no figure for a metal, nor for the metals together.
  const unknownMetal = { lots: 1, units: 1, costMinor: 50_000, sales: 0, saleNetMinor: 0 };
  const gold = input(off({ metalUnknown: unknownMetal }));
  const silver = input(off({ metal: 'XAG', metalUnknown: unknownMetal }));
  assert.deepEqual(totalsResult(gold, PROVEN),
    { kind: 'unavailable', title: TOTALS_UNAVAILABLE, action: 'review', lead: `${metalUnknownText(1)}.`, lines: [`${metalUnknownText(1)}.`] });
  // Each metal's Bought says what it leaves out, right under it; the metals together say it once.
  assert.ok(goldTotals(gold, PROVEN).bought.limits.includes('Not included: 1 recorded purchase whose metal is unresolved.'));
  const together = combinedTotals([gold, silver].map((item) => ({ input: item, totals: goldTotals(item, PROVEN) })));
  assert.equal(together?.result.kind, 'unavailable');
  assert.equal(together?.result.kind === 'unavailable' && together.result.lines[0], '1 purchase or sale has an unresolved metal, so it belongs to no one metal’s totals.');
  assert.deepEqual(together?.bought.limits.filter((limit) => /unresolved/.test(limit)), ['Not included: 1 recorded purchase whose metal is unresolved.']);
  const unknownSale = { lots: 0, units: 0, costMinor: 0, sales: 2, saleNetMinor: 80_000 };
  const goldSale = input(off({ metalUnknown: unknownSale }));
  assert.ok(goldTotals(goldSale, PROVEN).sold.limits.includes('Not included: 2 recorded sales whose metal is unresolved.'));
  const withSales = combinedTotals([goldSale, input(off({ metal: 'XAG', metalUnknown: unknownSale }))]
    .map((item) => ({ input: item, totals: goldTotals(item, PROVEN) })));
  assert.deepEqual(withSales?.sold.limits.filter((limit) => /unresolved/.test(limit)), ['Not included: 2 recorded sales whose metal is unresolved.']);
});

test('appendix choice 4: nothing delivered held and no usable close yet, the estimate stands without a price; its purchases are read', () => {
  // 5b01e72f's sealed appendix (e6d787e8), choice 4: proven zero delivered holdings need no quote, missing or stale.
  const noClose = overviewFixture({ price: { ...base.price, closeDate: null, close: null } });
  const soldOut = withHoldings(noClose, {
    troyOz: complete(oz('0/1', '0.000')), costMinor: complete(0), units: units({ delivered: 1, sold: 1, soldFromDelivered: 1 }),
  });
  // The caller reads the purchases (the estimate's check), as it does while values show.
  assert.equal(totalsReadsPurchases(base), true);
  assert.equal(totalsReadsPurchases(soldOut), true);
  // No price is used, so none is named: no value at spot, no quote and no date.
  assert.deepEqual(totalsResult(input(soldOut), PROVEN), {
    kind: 'estimate', valueMinor: 45_000, figure: signedUsd(45_000), unpriced: true,
    lines: [TOTALS_NO_PRICE_NEEDED, TOTALS_SALES_BASIS, TOTALS_SALES_METHOD, TOTALS_BEFORE_REWARDS],
  });
  // Units on the way count at what was paid.
  const onTheWay = withHoldings(soldOut, { units: units({ delivered: 1, sold: 1, soldFromDelivered: 1, awaiting: 1, awaitingUnassigned: 1 }) });
  assert.deepEqual(totalsResult(input(onTheWay), PROVEN), {
    kind: 'estimate', valueMinor: 45_000, figure: signedUsd(45_000), unpriced: true,
    lines: [TOTALS_NO_PRICE_NEEDED, TOTALS_BASIS_ON_THE_WAY_AT_COST, '1 unit on the way counts at what you paid until delivered.', TOTALS_BEFORE_REWARDS],
  });
  // Every other gate still applies: a cancelled or returned purchase left unsettled refuses it.
  const cancelled = purchaseFixture({ key: 'costco-line-cccc', units: { ordered: 1, cancelled: 1, returned: 0, delivered: 0, awaiting: 0 }, delivery: { state: 'cancelled', date: null } });
  assert.equal(totalsResult(input(soldOut, purchasesOf(purchaseFixture(), cancelled)), PROVEN).kind, 'sales');
  // Prices off stay apart; stock still held, or no sale recorded, keeps the result without a price as before.
  const offSoldOut = { ...soldOut, price: { ...soldOut.price, fetching: false } };
  assert.equal(totalsReadsPurchases(offSoldOut), false);
  assert.equal(totalsResult(input(offSoldOut, null), PROVEN).kind, 'sales');
  assert.equal(totalsReadsPurchases(noClose), false);
  assert.equal(totalsResult(input(noClose, null), PROVEN).kind, 'sales');
  const neverSold = withoutSales(soldOut);
  assert.equal(totalsReadsPurchases(neverSold), false);
  assert.deepEqual(totalsResult(input(neverSold, null), PROVEN), {
    kind: 'sales', valueMinor: 0, figure: null,
    lines: [`${TOTALS_NO_SALES} Holdings are not valued: no usable CNBC close for gold is stored yet; their gain or loss is not included.`],
  });
  // Never sold, nothing delivered held, a unit on the way at a known cost (5b01e72f, C2-H4): the estimate stands without
  // a price at that cost (zero), its purchases are read, and it adds to another metal's estimate on one basis.
  const noSalesProven: GoldCoverageProof = { sales: { state: 'no-sales', gaps: [] }, asOf: { state: 'complete', gaps: [] } };
  const unsoldOnTheWay = withHoldings(withoutSales(noClose), {
    troyOz: complete(oz('0/1', '0.000')), costMinor: complete(0), units: units({ awaiting: 1, awaitingUnassigned: 1 }),
  });
  assert.equal(totalsReadsPurchases(unsoldOnTheWay), true);
  assert.deepEqual(totalsResult(input(unsoldOnTheWay), noSalesProven), {
    kind: 'estimate', valueMinor: 0, figure: signedUsd(0), unpriced: true,
    lines: [TOTALS_NO_PRICE_NEEDED, TOTALS_BASIS_ON_THE_WAY_AT_COST, '1 unit on the way counts at what you paid until delivered.', TOTALS_NO_SALES,
      TOTALS_BEFORE_REWARDS],
  });
  const silverUnsold = withHoldings(withoutSales(overviewFixture({ metal: 'XAG', price: { ...base.price, closeDate: null, close: null } })), {
    troyOz: complete(oz('0/1', '0.000')), costMinor: complete(0), units: units({ awaiting: 1, awaitingUnassigned: 1 }),
  });
  const pricedGold = input();
  const unsoldSilver = input(silverUnsold);
  assert.deepEqual(combinedTotals([{ input: pricedGold, totals: goldTotals(pricedGold, PROVEN) },
    { input: unsoldSilver, totals: goldTotals(unsoldSilver, noSalesProven) }])?.result,
  { kind: 'estimate', valueMinor: 175_080, figure: signedUsd(175_080), lines: [TOTALS_ESTIMATE_QUALIFIER, TOTALS_BEFORE_REWARDS] });
  // The metals together on one basis: none priced, no holdings-valuation claim; one priced, the estimate's own words.
  const silverSoldOut = withHoldings(overviewFixture({ metal: 'XAG', price: { ...base.price, closeDate: null, close: null } }), {
    troyOz: complete(oz('0/1', '0.000')), costMinor: complete(0), units: units({ delivered: 1, sold: 1, soldFromDelivered: 1 }),
  });
  const together = (...items: GoldTotalsInput[]) => combinedTotals(items.map((item) => ({ input: item, totals: goldTotals(item, PROVEN) })));
  assert.deepEqual(together(input(soldOut), input(silverSoldOut))?.result,
    { kind: 'estimate', valueMinor: 90_000, figure: signedUsd(90_000), unpriced: true, lines: [TOTALS_NO_PRICE_NEEDED, TOTALS_BEFORE_REWARDS] });
  const silverOnTheWay = withHoldings(silverSoldOut, { units: units({ delivered: 1, sold: 1, soldFromDelivered: 1, awaiting: 1, awaitingUnassigned: 1 }) });
  assert.deepEqual(together(input(soldOut), input(silverOnTheWay))?.result.lines,
    [TOTALS_NO_PRICE_NEEDED, TOTALS_BASIS_ON_THE_WAY_AT_COST, TOTALS_BEFORE_REWARDS]);
  assert.deepEqual(together(input(), input(silverSoldOut))?.result,
    { kind: 'estimate', valueMinor: 175_080 + 45_000, figure: signedUsd(220_080), lines: [TOTALS_ESTIMATE_QUALIFIER, TOTALS_BEFORE_REWARDS] });
});

test('the metals together with no sale in any of them: "No sales recorded", never a $0 answer while holdings aren\'t in it', () => {
  const noSales = (metal: 'XAU' | 'XAG') => input(withoutSales(off({ metal })));
  const both = combinedTotals([noSales('XAU'), noSales('XAG')].map((item) => ({ input: item, totals: goldTotals(item, PROVEN) })));
  assert.deepEqual(both?.result, { kind: 'sales', valueMinor: 0, figure: null, lines: [TOTALS_COMBINED_NO_SALES] });
  // One metal sold: the sum, with the other's none as nothing.
  const one = combinedTotals([input(off()), noSales('XAG')].map((item) => ({ input: item, totals: goldTotals(item, PROVEN) })));
  assert.deepEqual(one?.result, { kind: 'sales', valueMinor: 45_000, figure: signedUsd(45_000), lines: [TOTALS_SALES_BASIS, TOTALS_HELD_EXCLUDED, TOTALS_BEFORE_REWARDS] });
});

test('C2-H4: values shown, the metals together count every metal with stock, sold or not; unsold stock on unproven history refuses', () => {
  // 5b01e72f's sealed review e6d787e8 (C2-H4 and its case 6): the prices-on total needs every contributing metal's as-of
  // verdict, including metals never sold; no sales is a sales-scope state, never a pass.
  const noSalesProven: GoldCoverageProof = { sales: { state: 'no-sales', gaps: [] }, asOf: { state: 'complete', gaps: [] } };
  const noSalesGap: GoldCoverageProof = { sales: { state: 'no-sales', gaps: [] }, asOf: { state: 'incomplete', gaps: ['Silver purchases before Jan 2025 aren’t captured.'] } };
  const gold = input();
  const silver = input(withoutSales(overviewFixture({ metal: 'XAG' })));
  // Unsold silver on proven history: its delivered holdings' gain is its estimate, and it counts in the metals together.
  assert.deepEqual(totalsResult(silver, noSalesProven), {
    kind: 'estimate', valueMinor: 130_080, figure: signedUsd(130_080),
    lines: [TOTALS_ESTIMATE_QUALIFIER, TOTALS_ESTIMATE_BASIS, TOTALS_NO_SALES,
      `Estimated using silver spot · CNBC close, ${dateText('2026-11-06')}. Not a guaranteed sale price.`, TOTALS_BEFORE_REWARDS],
  });
  const both = combinedTotals([{ input: gold, totals: goldTotals(gold, PROVEN) }, { input: silver, totals: goldTotals(silver, noSalesProven) }]);
  assert.deepEqual(both?.result, { kind: 'estimate', valueMinor: 175_080 + 130_080, figure: signedUsd(305_160), lines: [TOTALS_ESTIMATE_QUALIFIER, TOTALS_BEFORE_REWARDS] });
  // Unsold silver on unproven history: no figure for it, and so none for the metals together: never left out.
  assert.deepEqual(totalsResult(silver, noSalesGap), {
    kind: 'unavailable', title: TOTALS_NO_SALES, action: 'coverage', lead: 'Silver purchases before Jan 2025 aren’t captured.',
    lines: ['Holdings are not included in this result.', 'Silver purchases before Jan 2025 aren’t captured.'],
  });
  const refused = combinedTotals([{ input: gold, totals: goldTotals(gold, PROVEN) }, { input: silver, totals: goldTotals(silver, noSalesGap) }]);
  assert.deepEqual(refused?.result, {
    kind: 'unavailable', title: TOTALS_COMBINED_UNAVAILABLE, action: 'coverage', lead: 'Silver’s profit or loss is unavailable.',
    lines: ['Silver’s profit or loss is unavailable.'],
  });
  // Only unsold stock, in every metal, on unproven history: no total; an empty set of sales proves nothing.
  const goldUnsold = input(withoutSales(overviewFixture()));
  const none = combinedTotals([goldUnsold, silver].map((item) => ({ input: item, totals: goldTotals(item, noSalesGap) })));
  assert.equal(none?.result.kind, 'unavailable');
  assert.equal(none?.resultLabel, null);
});

test('the totals\' words: heading, as of, ounces never unqualified while partial, nothing sold said in words', () => {
  const totals = goldTotals(input(off()), PROVEN);
  assert.equal(totals.heading, 'Your gold · all recorded history');
  assert.equal(totals.asOf, `As of ${dateText('2026-11-08')}`);
  assert.deepEqual(totals.bought, { figure: usd(600_000), state: 'complete', sub: '3.000 troy oz · 3 recorded purchases', short: null, unverified: false, limits: [] });
  assert.deepEqual(totals.sold, { figure: usd(245_000), state: 'complete', sub: '1.000 troy oz · 1 recorded sale · proceeds after fees', short: null, unverified: false, limits: [] });
  assert.equal(totals.resultLabel, TOTALS_SALES_LABEL);
  assert.equal(goldTotals(input(), PROVEN).resultLabel, TOTALS_RESULT_LABEL);
  // Each says the result is before rewards (ROOT, from the owner's reaction): never read as a final result.
  assert.deepEqual([TOTALS_SALES_LABEL, TOTALS_RESULT_LABEL],
    ['Profit or loss on recorded sales, before rewards', 'Profit or loss, before rewards']);
  assert.equal(goldTotals(input(off({ metal: 'XAG' })), PROVEN).heading, 'Your silver · all recorded history');
  const partialOunces = withActivity(off(), { bought: { ...base.activity.bought, troyOz: partial(oz('3/1', '3.000'), ['content-unknown', 1]) } });
  assert.deepEqual(goldTotals(input(partialOunces), PROVEN).bought, {
    figure: usd(600_000), state: 'complete', sub: '3.000 troy oz confirmed so far · 3 recorded purchases', short: null, unverified: false,
    limits: [reasonText({ code: 'content-unknown', records: 1 }, 'XAU')],
  });
  const unknownOunces = withActivity(off(), { bought: { ...base.activity.bought, troyOz: unknown(['content-unknown', 3]) } });
  assert.equal(goldTotals(input(unknownOunces), PROVEN).bought.sub, 'troy oz unknown · 3 recorded purchases');
  const noSales = withActivity(off(), {
    sold: { lines: 0, units: 0, troyOz: complete(oz('0/1', '0.000')), grossMinor: complete(0), feesMinor: complete(0), netMinor: complete(0), unmatched: { units: 0, netMinor: 0, reasons: [] } },
    profit: { valueMinor: complete(0), coverage: { basis: 'troy-oz', known: oz('0/1', '0.000'), total: oz('0/1', '0.000'), unknownContentLines: 0 } },
  });
  const quiet = goldTotals(input(noSales), PROVEN);
  assert.deepEqual([quiet.sold.figure, quiet.sold.state], ['No sales recorded', 'none']);
  assert.deepEqual(quiet.result, { kind: 'sales', valueMinor: 0, figure: null, lines: [TOTALS_NO_SALES_OFF] });
  // The sales scope says "no sales": the same words, nothing inferred complete.
  const noSalesScope: GoldCoverageProof = { sales: { state: 'no-sales', gaps: [] }, asOf: PROVEN.asOf };
  assert.deepEqual(goldTotals(input(noSales), noSalesScope).result, { kind: 'sales', valueMinor: 0, figure: null, lines: [TOTALS_NO_SALES_OFF] });
  // No proof: "no sales recorded" is never a proven lifetime zero.
  assert.deepEqual(goldTotals(input(noSales), null).result,
    { kind: 'unavailable', title: TOTALS_NO_SALES, action: 'coverage', lead: TOTALS_COVERAGE_UNVERIFIABLE, lines: [TOTALS_HELD_OFF, ...UNSERVED] });
  assert.equal(goldTotals(input(noSales), null).resultLabel, TOTALS_RESULT_LABEL);
  assert.equal(resultLabelOf({ kind: 'unavailable', title: TOTALS_NOT_COVERED, lead: null, lines: [], action: 'coverage' }), null);
  const noPurchases = withActivity(off(), { bought: { lots: 0, units: 0, troyOz: complete(oz('0/1', '0.000')), costMinor: complete(0) } });
  assert.deepEqual([goldTotals(input(noPurchases), PROVEN).bought.figure, goldTotals(input(noPurchases), PROVEN).bought.state], ['No recorded purchases', 'none']);
  assert.equal(combinedTitle(['XAU', 'XAG']), 'Gold and silver combined');
  assert.equal(combinedTitle(['XAU', 'XAG', 'XPT']), 'Gold, silver and platinum combined');
});

// Astra's review of b558ebcc: beside each figure only its limitation in short; every reason once, under one fold, with
// the figures it affects; a refusal keeps its principal reason and its action in view.
test('each figure says its limitation in short beside it: its state, what it leaves out by count, an unverified history', () => {
  // Complete as recorded, on unproven history.
  const unproven = goldTotals(input(off()), null);
  assert.deepEqual([unproven.bought.short, unproven.sold.short], ['Recorded so far · history unverified', 'Recorded so far · history unverified']);
  assert.deepEqual([unproven.bought.unverified, unproven.sold.unverified], [true, true]);
  // Proven and complete: nothing to say.
  const proven = goldTotals(input(off()), PROVEN);
  assert.deepEqual([proven.bought.short, proven.sold.short, proven.why], [null, null, []]);
  // Partial: the state word, never "recorded so far" alone.
  const held = withActivity(off(), {
    bought: { ...base.activity.bought, costMinor: partial(600_000, ['source-held', 1]) },
    sold: { ...base.activity.sold, netMinor: partial(245_000, ['source-held', 1]) },
    profit: { ...base.activity.profit, valueMinor: partial(45_000, ['source-held', 1]) },
  });
  const partialTotals = goldTotals(input(held), null);
  assert.deepEqual([partialTotals.bought.short, partialTotals.sold.short], ['Partial · history unverified', 'Partial · history unverified']);
  // Unknown: no figure, said so.
  const unknownCost = withActivity(off(), { bought: { ...base.activity.bought, costMinor: unknown(['cost-unattributed', 3]) } });
  const unknownTotals = goldTotals(input(unknownCost), PROVEN);
  assert.deepEqual([unknownTotals.bought.figure, unknownTotals.bought.short], ['—', 'Unknown']);
  // Records of unresolved metal: left out by count, beside the figure that leaves them out.
  const unresolved = off({ metalUnknown: { lots: 1, units: 1, costMinor: 50_000, sales: 2, saleNetMinor: 80_000 } });
  const left = goldTotals(input(unresolved), PROVEN);
  assert.deepEqual([left.bought.short, left.sold.short], ['Recorded so far · 1 purchase not included', 'Recorded so far · 2 sales not included']);
  assert.equal(goldTotals(input(unresolved), null).sold.short, 'Recorded so far · 2 sales not included · history unverified');
  // Nothing recorded on unproven history: none so far, said so.
  const noPurchases = withActivity(off(), { bought: { lots: 0, units: 0, troyOz: complete(oz('0/1', '0.000')), costMinor: complete(0) } });
  assert.deepEqual(goldTotals(input(noPurchases), null).bought.short, 'Recorded so far · history unverified');
});

test('every reason is said once, with each figure it affects; a refusal keeps its principal reason in view', () => {
  const held = withActivity(off(), {
    bought: { ...base.activity.bought, costMinor: partial(600_000, ['source-held', 1]) },
    sold: { ...base.activity.sold, netMinor: partial(245_000, ['source-held', 1]) },
    profit: { ...base.activity.profit, valueMinor: partial(45_000, ['source-held', 1]) },
  });
  const heldText = reasonText({ code: 'source-held', records: 1 }, 'XAU');
  const totals = goldTotals(input(held), null);
  assert.deepEqual(totals.result, {
    kind: 'unavailable', title: TOTALS_UNAVAILABLE, action: 'coverage', lead: TOTALS_COVERAGE_UNVERIFIABLE, lines: [TOTALS_COVERAGE_UNVERIFIABLE, heldText],
  });
  assert.deepEqual(totals.why, [
    { text: heldText, figures: [TOTALS_FIGURES.bought, TOTALS_FIGURES.sold, TOTALS_FIGURES.result] },
    { text: TOTALS_BOUGHT_UNVERIFIED, figures: [TOTALS_FIGURES.bought] },
    { text: TOTALS_SOLD_UNVERIFIED, figures: [TOTALS_FIGURES.sold] },
    { text: TOTALS_COVERAGE_UNVERIFIABLE, figures: [TOTALS_FIGURES.result] },
  ]);
  // Every limitation of every figure is in it: none is lost to the short line.
  const said = new Set(totals.why.map((reason) => reason.text));
  for (const text of [...totals.bought.limits, ...totals.sold.limits, ...(totals.result.kind === 'unavailable' ? totals.result.lines : [])]) {
    assert.ok(said.has(text), text);
  }
  // Recorded purchases don't cover the sales: the title says it, so no other line is put before the rest.
  const unmatched = withActivity(off(), {
    sold: unmatchedSale,
    profit: { valueMinor: unknown(['unmatched-sales', 1]), coverage: { basis: 'troy-oz', known: oz('0/1', '0.000'), total: oz('1/1', '1.000'), unknownContentLines: 0 } },
  });
  const notCovered = goldTotals(input(unmatched), null);
  assert.equal(notCovered.result.kind === 'unavailable' && notCovered.result.title, TOTALS_NOT_COVERED);
  assert.equal(notCovered.result.kind === 'unavailable' && notCovered.result.lead, null);
  assert.ok(notCovered.why.some((reason) => reason.text === TOTALS_COVERAGE_UNVERIFIABLE && reason.figures.includes(TOTALS_FIGURES.result)));
  // ...and the fold lists that title too, with the figure it affects, so the fold alone holds every reason.
  assert.deepEqual(notCovered.why.find((reason) => reason.text === TOTALS_NOT_COVERED)?.figures, [TOTALS_FIGURES.result]);
  // A figure's own basis lines stay beside it, never folded among the reasons.
  const salesOnly = goldTotals(input(off()), PROVEN);
  assert.equal(salesOnly.result.kind, 'sales');
  assert.deepEqual(salesOnly.why, []);
  // The metals together: each metal's limitations by name, the refusal's reason first in view.
  const gold = input(off());
  const silver = input(off({ metal: 'XAG' }));
  const together = combinedTotals([gold, silver].map((item) => ({ input: item, totals: goldTotals(item, null) })));
  assert.equal(together?.bought.short, 'Recorded so far · history unverified');
  assert.equal(together?.result.kind === 'unavailable' && together.result.lead, 'Gold’s profit or loss is unavailable.');
  assert.deepEqual(together?.why.map((reason) => [reason.text, reason.figures.join(' · ')]), [
    [`Gold: ${TOTALS_BOUGHT_UNVERIFIED}`, TOTALS_FIGURES.bought],
    [`Silver: ${TOTALS_BOUGHT_UNVERIFIED}`, TOTALS_FIGURES.bought],
    [`Gold: ${TOTALS_SOLD_UNVERIFIED}`, TOTALS_FIGURES.sold],
    [`Silver: ${TOTALS_SOLD_UNVERIFIED}`, TOTALS_FIGURES.sold],
    ['Gold’s profit or loss is unavailable.', TOTALS_FIGURES.result],
    ['Silver’s profit or loss is unavailable.', TOTALS_FIGURES.result],
  ]);
});

test('a profit or loss is for every sale only when each sale line is known', () => {
  assert.equal(profitFullyKnown({ basis: 'troy-oz', known: oz('1/1', '1.000'), total: oz('1/1', '1.000'), unknownContentLines: 0 }), true);
  assert.equal(profitFullyKnown({ basis: 'troy-oz', known: oz('1/2', '0.500'), total: oz('1/1', '1.000'), unknownContentLines: 0 }), false);
  assert.equal(profitFullyKnown({ basis: 'sale-lines', known: 4, total: 4, unknownContentLines: 0 }), true);
  assert.equal(profitFullyKnown({ basis: 'sale-lines', known: 2, total: 4, unknownContentLines: 1 }), false);
  assert.equal(profitFullyKnown({ basis: 'sale-lines', known: 4, total: 4, unknownContentLines: 1 }), false);
});

test('the owner\'s fungible policy: each result that states the method says "across all forms (your rule)", only for a metal it names', () => {
  assert.equal(TOTALS_SALES_METHOD_FUNGIBLE,
    'Costs assigned oldest first across all forms (your rule); this does not identify which bars or coins were sold.');
  const policy = (overview: MetalsOverview, fungible: Array<MetalsOverview['metal']>): MetalsOverview =>
    ({ ...overview, assignment: { rule: 'metals-assignment-v1+fungible', fungible } });
  const fungibleWords = (result: ReturnType<typeof totalsResult>) =>
    ({ ...result, lines: result.lines.map((line) => (line === TOTALS_SALES_METHOD ? TOTALS_SALES_METHOD_FUNGIBLE : line)) });
  // The three results that state it: prices off; a stale close holding the estimate back; the estimate without a price.
  const stale = withHoldings(overviewFixture({ price: { ...base.price, stale: true } }), {
    valueMinor: partial(530_080, ['price-stale', 1]), gainMinor: partial(130_080, ['price-stale', 1]),
  });
  const soldOut = withHoldings(overviewFixture({ price: { ...base.price, closeDate: null, close: null } }), {
    troyOz: complete(oz('0/1', '0.000')), costMinor: complete(0), units: units({ delivered: 1, sold: 1, soldFromDelivered: 1 }),
  });
  for (const overview of [off(), stale, soldOut]) {
    const before = totalsResult(input(overview), PROVEN);
    assert.ok(before.lines.includes(TOTALS_SALES_METHOD), before.kind);
    assert.deepEqual(totalsResult(input(policy(overview, ['XAU'])), PROVEN), fungibleWords(before));
    assert.deepEqual(totalsResult(input(policy(overview, ['XAU', 'XAG'])), PROVEN), fungibleWords(before));
    // The policy names silver alone: gold's words are metals-assignment-v1's.
    assert.deepEqual(totalsResult(input(policy(overview, ['XAG'])), PROVEN), before);
  }
});
