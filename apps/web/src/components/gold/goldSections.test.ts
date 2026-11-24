import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup as staticMarkup } from 'react-dom/server';

import { GoldHeldChart } from './GoldChart';
import { GoldHoldings } from './GoldHoldings';
import { GoldCancelled, GoldPurchases, GoldSales } from './GoldLists';
import { GoldRewards } from './GoldRewards';
import { GoldSources } from './GoldSources';
import { GoldResult, GoldToCheck } from './GoldSummary';
import type { MetalsFunding, MetalsOverview, MetalsPurchase, MetalsPurchases, MetalsRead, MetalsSales } from './goldApi';
import {
  complete, fundingPurchaseFixture, overviewFixture, oz, partial, purchaseFixture, saleFixture, soldOutOverview, timelineFixture, unknown,
} from './goldFixtures';
import {
  goldReadFailed, goldReadShown, goldSectionsBusy, periodFunding, periodList, periodTimeline, type GoldScope, type GoldTimelineAnswer,
} from './goldReads';
import { REWARDS_INCOMPLETE, REWARDS_NONE_KEPT, REWARDS_NONE_RECORDED } from './goldRewardsStatus';
import { PERIOD_NO_SALES, PROFIT_METHOD, assignmentMethodText, deliveryInferredText, holdingsClassesTitle, profitMethod } from './goldText';

// Synthetic fixtures only: the sections as the server renders them (no DOM). A section of one read, read again after a
// write, keeps the period's own answer, marked as updating and busy; a read again that fails shows its error, never the
// answer from before (the Gold lead's two conditions).
const PERIOD = { from: '2026-05-08', to: '2026-11-08' };
const SCOPE: GoldScope = { metal: 'XAU', ...PERIOD };
/** Static markup, without any separator a renderer may put between adjacent texts, so a sentence reads as one. */
const renderToStaticMarkup = (node: Parameters<typeof staticMarkup>[0]) => staticMarkup(node).replace(/<!-- -->/g, '');
const UPDATING = 'spinner-label visually-hidden">Updating<';
const noop = () => {};
/** No read under way; then the overview alone still under way (other sections show its spot and unresolved line). */
const IDLE = { overview: false, purchases: false, sales: false, timeline: false, funding: false };
const OVERVIEW_PENDING = goldSectionsBusy({ ...IDLE, overview: true });
const overview = () => {
  const base = overviewFixture();
  return { ...base, activity: { ...base.activity, ...PERIOD } };
};

/** The element marked `testId`, from its opening tag to the end of its section. */
function sectionOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  assert.ok(at >= 0, `${testId} is drawn`);
  const end = html.indexOf('</section>', at);
  return html.slice(html.lastIndexOf('<', at), end < 0 ? undefined : end);
}
const openingTag = (html: string, testId: string) => {
  const section = sectionOf(html, testId);
  return section.slice(0, section.indexOf('>') + 1);
};

test('the period summary read again keeps the period\'s own figures, marked as updating and busy; before its answer, none', () => {
  const props = { overview: overview(), choice: '6m' as const, period: PERIOD, onReview: noop };
  const at = (busy: boolean, current: boolean) => renderToStaticMarkup(createElement(GoldResult, { ...props, busy, current }));
  const rest = at(false, true);
  assert.match(sectionOf(rest, 'gold-period'), /data-testid="gold-paid"/);
  assert.doesNotMatch(openingTag(rest, 'gold-period'), /aria-busy/);
  assert.doesNotMatch(openingTag(rest, 'gold-holding'), /aria-busy/);
  assert.ok(!rest.includes(UPDATING));
  // Read again after a write: the same period's figures stay, marked as updating, each section busy.
  const again = at(true, true);
  assert.match(sectionOf(again, 'gold-period'), /data-testid="gold-paid"/);
  for (const testId of ['gold-period', 'gold-holding']) {
    assert.ok(sectionOf(again, testId).includes(UPDATING), testId);
    assert.match(openingTag(again, testId), /aria-busy="true"/, testId);
  }
  assert.match(openingTag(again, 'gold-summary'), /aria-busy="true"/);
  // The overview doesn't answer the period chosen yet: no figure of the period, no completeness line; said being read.
  const other = at(true, false);
  assert.doesNotMatch(other, /data-testid="gold-paid"|data-testid="gold-brought-in"|data-testid="gold-sale-profit"|data-testid="gold-summary-warning"/);
  assert.ok(sectionOf(other, 'gold-period').includes(UPDATING));
  assert.match(openingTag(other, 'gold-period'), /aria-busy="true"/);
});

test('what you held, read again, keeps the period\'s months marked as updating and busy; a read again that failed, the error', () => {
  const props = { metal: 'XAU' as const, start: '2026-05-01', end: '2026-11-08', spot: 'shown' as const };
  const rest = renderToStaticMarkup(createElement(GoldHeldChart, { ...props, timeline: timelineFixture(), error: null }));
  assert.match(rest, /data-testid="gold-held-plot"/);
  assert.doesNotMatch(openingTag(rest, 'gold-held-chart'), /aria-busy/);
  assert.ok(!rest.includes(UPDATING));
  const again = renderToStaticMarkup(createElement(GoldHeldChart, { ...props, timeline: timelineFixture(), error: null, busy: true }));
  assert.match(again, /data-testid="gold-held-plot"/);
  assert.match(openingTag(again, 'gold-held-chart'), /aria-busy="true"/);
  assert.ok(again.includes(UPDATING));
  // Its timeline in, the overview (its spot, its unresolved line) still under way: still marked.
  const overviewPending = renderToStaticMarkup(createElement(GoldHeldChart, {
    ...props, timeline: timelineFixture(), error: null, busy: OVERVIEW_PENDING.held,
  }));
  assert.match(openingTag(overviewPending, 'gold-held-chart'), /aria-busy="true"/);
  assert.ok(overviewPending.includes(UPDATING));
  // The read again failed: it keeps no months (goldReadFailed), so the chart says the error, never the months from before.
  const failed = goldReadShown(goldReadFailed<GoldTimelineAnswer>('XAU', 'r2', 'Synthetic failure', false), 'XAU', 'r2');
  const html = renderToStaticMarkup(createElement(GoldHeldChart, {
    ...props, timeline: periodTimeline(failed, SCOPE), error: failed.error, busy: failed.busy,
  }));
  assert.match(html, /What you held couldn.{1,6}t be read: Synthetic failure/);
  assert.doesNotMatch(html, /data-testid="gold-held-plot"/);
  assert.doesNotMatch(openingTag(html, 'gold-held-chart'), /aria-busy/);
});

test('a list read again keeps the period\'s rows marked as updating and busy; a read again that failed says so, with no row', () => {
  const common = { metal: 'XAU' as const, scope: 'the last 6 months', onConfirm: noop };
  const purchasesProps = { ...common, funding: null, fundingError: null, onOpenCharge: noop, onOpenInCardTransactions: noop };
  const purchases: MetalsPurchases = { installed: true, ...SCOPE, purchases: [purchaseFixture()] };
  const sales: MetalsSales = { installed: true, ...SCOPE, sales: [saleFixture()] };
  const drawn = {
    purchases: (read: MetalsPurchases | null, error: string | null, busy: boolean) =>
      renderToStaticMarkup(createElement(GoldPurchases, { ...purchasesProps, read, error, busy })),
    sales: (read: MetalsSales | null, error: string | null, busy: boolean) =>
      renderToStaticMarkup(createElement(GoldSales, { ...common, spot: 'shown', read, error, busy })),
  };
  for (const [name, html, row] of [
    ['gold-purchases', drawn.purchases(purchases, null, true), 'gold-purchase'],
    ['gold-sales', drawn.sales(sales, null, true), 'gold-sale'],
  ] as const) {
    assert.match(html, new RegExp(`data-testid="${row}"`), name);
    assert.match(openingTag(html, name), /aria-busy="true"/, name);
    assert.ok(sectionOf(html, name).includes(UPDATING), name);
  }
  assert.doesNotMatch(openingTag(drawn.purchases(purchases, null, false), 'gold-purchases'), /aria-busy/);
  // The sales in, the overview (their spot) still under way: still marked.
  const overviewPending = drawn.sales(sales, null, OVERVIEW_PENDING.sales);
  assert.match(openingTag(overviewPending, 'gold-sales'), /aria-busy="true"/);
  assert.ok(sectionOf(overviewPending, 'gold-sales').includes(UPDATING));
  // The read again failed: no answer is kept (goldReadFailed), so no row from before, the error said, nothing busy.
  const failedPurchases = goldReadShown(goldReadFailed<MetalsRead<MetalsPurchases>>('XAU', 'r2', 'Synthetic failure', false), 'XAU', 'r2');
  const failedSales = goldReadShown(goldReadFailed<MetalsRead<MetalsSales>>('XAU', 'r2', 'Synthetic failure', false), 'XAU', 'r2');
  for (const [name, html, row, words] of [
    ['gold-purchases', drawn.purchases(periodList(failedPurchases, SCOPE), failedPurchases.error, failedPurchases.busy), 'gold-purchase', 'Purchases'],
    ['gold-sales', drawn.sales(periodList(failedSales, SCOPE), failedSales.error, failedSales.busy), 'gold-sale', 'Sales'],
  ] as const) {
    assert.match(html, new RegExp(`${words} couldn.{1,6}t be read: Synthetic failure`), name);
    assert.doesNotMatch(html, new RegExp(`data-testid="${row}"`), name);
    assert.doesNotMatch(openingTag(html, name), /aria-busy/, name);
  }
});

test('the receipts, read again, keep the purchases section marked; a funding read again that failed says so, with no receipt', () => {
  const purchases: MetalsPurchases = { installed: true, ...SCOPE, purchases: [purchaseFixture()] };
  const funding: MetalsFunding = { installed: true, ...PERIOD, purchases: [fundingPurchaseFixture()], sales: [], deposits: [] };
  const base = { metal: 'XAU' as const, read: purchases, error: null, scope: 'the last 6 months', onOpenCharge: noop,
    onOpenInCardTransactions: noop, onConfirm: noop };
  // The purchases in, the funding read again still under way: its receipts stay, the section marked.
  const again = renderToStaticMarkup(createElement(GoldPurchases, {
    ...base, funding, fundingError: null, busy: goldSectionsBusy({ ...IDLE, funding: true }).purchases,
  }));
  assert.match(again, /data-testid="gold-receipts"/);
  assert.match(openingTag(again, 'gold-purchases'), /aria-busy="true"/);
  assert.ok(sectionOf(again, 'gold-purchases').includes(UPDATING));
  // The funding read again failed: it keeps no answer, so no receipt from before, the error said.
  const failed = goldReadShown(goldReadFailed<MetalsRead<MetalsFunding>>('funding', 'r2', 'Synthetic failure', false), 'funding', 'r2');
  const html = renderToStaticMarkup(createElement(GoldPurchases, {
    ...base, funding: periodFunding(failed, SCOPE), fundingError: failed.error, busy: goldSectionsBusy(IDLE).purchases,
  }));
  assert.match(html, /Receipts couldn.{1,6}t be read: Synthetic failure/);
  assert.doesNotMatch(html, /data-testid="gold-receipts"/);
  assert.doesNotMatch(openingTag(html, 'gold-purchases'), /aria-busy/);
});

test('the cancelled list, drawn afresh once both its reads are in, keeps the fold the page kept for it', () => {
  const purchases: MetalsPurchases = { installed: true, ...SCOPE, purchases: [] };
  const sales: MetalsSales = { installed: true, ...SCOPE, sales: [saleFixture({ status: 'cancelled' })] };
  const props = { metal: 'XAU' as const, purchases, sales, scope: 'the last 6 months', onOpenChange: noop };
  const open = renderToStaticMarkup(createElement(GoldCancelled, { ...props, open: true }));
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /data-testid="gold-set-aside"/);
  const closed = renderToStaticMarkup(createElement(GoldCancelled, { ...props, open: false }));
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /data-testid="gold-set-aside"/);
});

test('Details\' sections as of today (what to check, the holdings, where the figures come from), read again, are marked', () => {
  const checked = { ...overview(), toCheck: { records: 2, needsYou: [{ code: 'confirm-content' as const, products: 2 }], forInformation: [] } };
  const drawn = (busy: boolean) => ({
    'gold-to-check': renderToStaticMarkup(createElement(GoldToCheck, { overview: checked, onConfirm: noop, busy })),
    'gold-holdings': renderToStaticMarkup(createElement(GoldHoldings, { overview: checked, busy })),
    'gold-sources': renderToStaticMarkup(createElement(GoldSources, { overview: checked, open: true, busy })),
  });
  // At rest: as before, nothing marked.
  for (const [name, html] of Object.entries(drawn(false))) {
    assert.doesNotMatch(openingTag(html, name), /aria-busy/, name);
    assert.ok(!html.includes(UPDATING), name);
  }
  // The overview read again: what each shows (read before) stays, marked as updating, each section busy.
  for (const [name, html] of Object.entries(drawn(true))) {
    assert.match(openingTag(html, name), /aria-busy="true"/, name);
    assert.ok(sectionOf(html, name).includes(UPDATING), name);
  }
  const again = drawn(true);
  assert.match(again['gold-to-check'], /To check \(2 records\)/);
  assert.match(again['gold-holdings'], /data-testid="gold-class"/);
  // Where the figures come from keeps its toggle's own name while its spinner is beside the words.
  assert.match(again['gold-sources'], /class="fold-toggle"[^>]*aria-label="Where these figures come from"/);
  assert.match(again['gold-sources'], /data-testid="gold-coverage"/);
});

test('the owner\'s fungible policy, drawn: the units a sale took counted delivered under the class\'s sum, the method across all forms; unset, as before', () => {
  const plain = overview();
  const policy = { rule: 'metals-assignment-v1+fungible' as const, fungible: ['XAU' as const] };
  const [first] = plain.holdings.classes;
  /** Gold under the policy: its class across forms, `units` of it counted delivered because a sale took them. */
  const inferred = (units: number): MetalsOverview => ({
    ...plain,
    assignment: policy,
    holdings: {
      ...plain.holdings,
      classes: [{ ...first, key: 'XAU|any|1', form: 'any', reconciliation: { ...first.reconciliation, deliveryInferred: units } }],
    },
  });
  const holdings = (read: MetalsOverview) => sectionOf(renderToStaticMarkup(createElement(GoldHoldings, { overview: read })), 'gold-holdings');
  assert.ok(holdings(inferred(1)).includes(`<li>${deliveryInferredText(1)}</li>`));
  assert.match(holdings(inferred(1)), /<p class="gold-row-name">[^<]* troy oz gold pieces of any form<\/p>/);
  // Its classes' heading: by fine content, every form together; unset, by form.
  assert.ok(holdings(inferred(1)).includes(`<h4>${holdingsClassesTitle(true)}</h4>`));
  assert.ok(holdings(plain).includes('<h4>By form</h4>'));
  // None inferred (a class of form `any` serves 0): no such line, though the heading still says the policy. Unset (no
  // field at all, no `assignment`): no word of the policy anywhere.
  assert.doesNotMatch(holdings(inferred(0)), /counts? as delivered/);
  assert.ok(holdings(inferred(0)).includes(`<h4>${holdingsClassesTitle(true)}</h4>`));
  assert.doesNotMatch(holdings(plain), /your rule|counts? as delivered/);
  const method = (read: MetalsOverview) => {
    const html = renderToStaticMarkup(createElement(GoldSources, { overview: read, open: true }));
    const at = html.indexOf('data-testid="gold-assignment-method"');
    assert.ok(at >= 0, 'the method is drawn');
    return html.slice(html.indexOf('>', at) + 1, html.indexOf('</p>', at));
  };
  assert.equal(method(plain), assignmentMethodText(false));
  assert.equal(method(inferred(1)), assignmentMethodText(true));
  // A policy that names silver alone leaves gold's method as before.
  assert.equal(method({ ...plain, assignment: { ...policy, fungible: ['XAG'] } }), assignmentMethodText(false));
  // The period's profit or loss: its method line under the figure, across all forms only under the policy.
  const period = (read: MetalsOverview) => sectionOf(renderToStaticMarkup(createElement(GoldResult, {
    overview: read, choice: '6m' as const, period: PERIOD, onReview: noop, busy: false, current: true,
  })), 'gold-sale-profit');
  assert.ok(period(inferred(1)).includes(profitMethod(true)));
  assert.ok(period(plain).includes(profitMethod(false)));
  assert.ok(!period(plain).includes('your rule'));
});

test('a period with no sale recorded says so in words; a zero result over recorded sales stays a figure; unread sales keep theirs', () => {
  const base = overview();
  const at = (read: MetalsOverview) => renderToStaticMarkup(createElement(GoldResult, {
    overview: read, choice: '6m' as const, period: PERIOD, onReview: noop, busy: false, current: true,
  }));
  const withSales = (sold: Partial<MetalsOverview['activity']['sold']>, profit: Partial<MetalsOverview['activity']['profit']> = {}): MetalsOverview =>
    ({ ...base, activity: { ...base.activity, sold: { ...base.activity.sold, ...sold }, profit: { ...base.activity.profit, ...profit } } });
  const zero = { troyOz: complete(oz('0/1', '0.000')), grossMinor: complete(0), feesMinor: complete(0) };
  const noneCovered = { basis: 'troy-oz' as const, known: oz('0/1', '0.000'), total: oz('0/1', '0.000'), unknownContentLines: 0 as const };
  // Known none (Astra's R5): no sale line and the sales measure complete. Words where the figures would be, never "$0.00"
  // or a coverage of none.
  const none = at(withSales({ lines: 0, units: 0, ...zero, netMinor: complete(0) }, { valueMinor: complete(0), coverage: noneCovered }));
  assert.ok(none.includes(`data-testid="gold-brought-in-none">${PERIOD_NO_SALES}</span>`));
  assert.ok(none.includes(`data-testid="gold-sale-profit-none">${PERIOD_NO_SALES}.</span>`));
  assert.match(openingTag(none, 'gold-sale-profit'), /data-scope="none"/);
  assert.doesNotMatch(sectionOf(none, 'gold-period'), /\$0\.00|known for|by day agreed/i);
  // Neither row keeps a figure, its sub-line or the method: the words stand alone.
  assert.doesNotMatch(sectionOf(none, 'gold-brought-in'), /gold-figure|gold-row-sub/);
  assert.ok(!sectionOf(none, 'gold-sale-profit').includes(PROFIT_METHOD));
  // A sale of unresolved metal on record: never said as none (it is in no metal's sales); the figures stay.
  const unresolved = at({
    ...withSales({ lines: 0, units: 0, ...zero, netMinor: complete(0) }, { valueMinor: complete(0), coverage: noneCovered }),
    metalUnknown: { ...base.metalUnknown, sales: 1, saleNetMinor: 28_600 },
  });
  assert.ok(!unresolved.includes(PERIOD_NO_SALES));
  // Recorded sales whose result is zero: still a figure, "$0.00", with its method.
  const evenSales = at(withSales({}, { valueMinor: complete(0) }));
  assert.ok(!evenSales.includes(PERIOD_NO_SALES));
  assert.match(sectionOf(evenSales, 'gold-sale-profit'), /\$0\.00/);
  assert.ok(sectionOf(evenSales, 'gold-sale-profit').includes(PROFIT_METHOD));
  // No sale line, but the sales may be missing (not covered to the period's end): never said as none; the figure keeps its
  // state.
  const unread = at(withSales({ lines: 0, units: 0, ...zero, netMinor: partial(0, ['not-covered', 1]) },
    { valueMinor: partial(0, ['not-covered', 1]), coverage: noneCovered }));
  assert.ok(!unread.includes(PERIOD_NO_SALES));
  assert.match(sectionOf(unread, 'gold-brought-in'), /data-state="partial"/);
});

test('"Prices off" and "No price yet" under the gain are neutral words: a gain or loss colour goes on a number shown only', () => {
  const base = overview();
  const gainTag = (read: MetalsOverview) => {
    const html = renderToStaticMarkup(createElement(GoldResult, {
      overview: read, choice: '6m' as const, period: PERIOD, onReview: noop, busy: false, current: true,
    }));
    return openingTag(html, 'gold-gain');
  };
  const classesOf = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/);
  // Values shown, a gain: the number is coloured as a gain.
  assert.ok(classesOf(gainTag(base)).includes('gain'));
  // Prices off, and no price yet, over the same hidden gain: neutral words, no gain or loss class.
  for (const price of [{ ...base.price, fetching: false }, { ...base.price, closeDate: null, close: null }]) {
    const tag = gainTag({ ...base, price });
    assert.match(tag, /gold-spot-off/);
    assert.ok(!classesOf(tag).some((name) => name === 'gain' || name === 'loss'), tag);
  }
  // Values shown but the gain unknown: "—" with its state, no gain or loss class either.
  const unknownGain = gainTag({ ...base, holdings: { ...base.holdings, gainMinor: unknown<number>(['price-missing', 1]) } });
  assert.ok(!classesOf(unknownGain).some((name) => name === 'gain' || name === 'loss'), unknownGain);
});

test('the period\'s profit or loss is labelled before rewards in each state that shows it (ROOT, from the owner\'s reaction)', () => {
  const base = overview();
  const label = (read: MetalsOverview) => {
    const section = sectionOf(renderToStaticMarkup(createElement(GoldResult, {
      overview: read, choice: '6m' as const, period: PERIOD, onReview: noop, busy: false, current: true,
    })), 'gold-sale-profit');
    return /<span class="gold-result-label">([^<]*)<\/span>/.exec(section)?.[1];
  };
  const withProfit = (profit: Partial<MetalsOverview['activity']['profit']>, sold: Partial<MetalsOverview['activity']['sold']> = {}): MetalsOverview =>
    ({ ...base, activity: { ...base.activity, sold: { ...base.activity.sold, ...sold }, profit: { ...base.activity.profit, ...profit } } });
  const these = 'Profit or loss on these sales, before rewards';
  // Every sale's result known; unknown ("—" with why); a period with no sale recorded (its words): the same label.
  assert.equal(label(base), these);
  assert.equal(label(withProfit({ valueMinor: unknown<number>(['unmatched-sales', 1]) })), these);
  const none = { basis: 'troy-oz' as const, known: oz('0/1', '0.000'), total: oz('0/1', '0.000'), unknownContentLines: 0 as const };
  assert.equal(label(withProfit({ valueMinor: complete(0), coverage: none }, {
    lines: 0, units: 0, troyOz: complete(oz('0/1', '0.000')), grossMinor: complete(0), feesMinor: complete(0), netMinor: complete(0),
  })), these);
  // Known for some of the sales only: the covered sales'.
  const some = { basis: 'troy-oz' as const, known: oz('1/1', '1.000'), total: oz('3/1', '3.000'), unknownContentLines: 0 as const };
  assert.equal(label(withProfit({ valueMinor: complete(7_000), coverage: some })), 'Profit or loss on covered sales, before rewards');
});

test('everything recorded sold, and units sold with no purchase recorded at all: the holding says why its ounces are unknown, never a zero (ROOT)', () => {
  const holding = (read: MetalsOverview) => sectionOf(renderToStaticMarkup(createElement(GoldResult, {
    overview: read, choice: '6m' as const, period: PERIOD, onReview: noop, busy: false, current: true,
  })), 'gold-holding');
  const soldOut = soldOutOverview();
  const drawn = holding({ ...soldOut, activity: { ...soldOut.activity, ...PERIOD } });
  assert.ok(drawn.includes('data-testid="gold-held-why">Unknown because all your recorded purchases kept or on the way are sold, '
    + 'but 2 units you sold have no recorded purchase yet. Finding those purchases would confirm whether you hold 0 troy oz.</p>'), drawn);
  assert.ok(drawn.includes('troy oz unknown'));
  assert.doesNotMatch(drawn, /0\.000 troy oz/);
  // Ounces held and known: no such line.
  assert.ok(!holding(overview()).includes('gold-held-why'));
});

const purchasesRead = (list: MetalsPurchase[] = [purchaseFixture()]): MetalsPurchases => ({ installed: true, metal: 'XAU', ...PERIOD, purchases: list });
const rewardsAt = (props: Partial<Parameters<typeof GoldRewards>[0]> = {}) => renderToStaticMarkup(createElement(GoldRewards, {
  purchases: purchasesRead(), overview: overview(), busy: { purchases: false, overview: false }, open: true, onOpenChange: noop, ...props,
}));

test('the rewards line stays while either read is under way, marked as read, claiming nothing; its fold stays as the page keeps it (PR-R)', () => {
  const rest = rewardsAt();
  assert.match(rest, /data-testid="gold-rewards-figure"/);
  assert.match(rest, /data-testid="gold-rewards-cards"/);
  assert.doesNotMatch(openingTag(rest, 'gold-rewards'), /aria-busy/);
  assert.ok(!rest.includes(UPDATING));
  // Either read under way: the line stays, busy and marked, with no figure, need or card for the period; the fold stays open.
  for (const busy of [{ purchases: true, overview: false }, { purchases: false, overview: true }, { purchases: true, overview: true }]) {
    const html = rewardsAt({ busy });
    const name = JSON.stringify(busy);
    assert.match(openingTag(html, 'gold-rewards'), /aria-busy="true"/, name);
    assert.ok(sectionOf(html, 'gold-rewards').includes(UPDATING), name);
    assert.doesNotMatch(html, /gold-rewards-figure|gold-rewards-cards|gold-rewards-incomplete|gold-rewards-none|needs /, name);
    assert.match(html, /aria-expanded="true"[^>]*>.*How rewards are estimated/, name);
  }
  // The first read under way, nothing read yet: the line is there, being read.
  assert.match(openingTag(rewardsAt({ purchases: null, busy: { purchases: true, overview: false } }), 'gold-rewards'), /aria-busy="true"/);
  // At rest with no purchases read, or with reads that answer another period: nothing, as before.
  assert.equal(rewardsAt({ purchases: null }), '');
  assert.equal(rewardsAt({ purchases: { ...purchasesRead(), from: '2026-10-08' } }), '');
  // The fold is the page's: closed, it stays closed while read.
  assert.match(rewardsAt({ open: false, busy: { purchases: true, overview: false } }), /aria-expanded="false"/);
});

test('the rewards line says each state in words: none kept, none recorded, a partial figure, an unknown one (G1d, PR-R)', () => {
  const held = overview();
  const incomplete = { ...held, activity: { ...held.activity, bought: { ...held.activity.bought, costMinor: partial(600_000, ['source-held', 1]) } } };
  // Paid by gift card: a figure known (no reward), so its period decides whether it stands whole.
  const giftCard = purchaseFixture({
    key: 'walmart-line-g', orderKey: 'walmart-order-g', account: { accountId: 'mtl-acct-wm', source: 'walmart', label: 'Walmart 1' },
    cards: [], funding: [{ kind: 'gift-card', network: 'unknown', amountMinor: 200_000 }],
  });
  const line = (list: MetalsPurchase[], over = overview()) => sectionOf(rewardsAt({ purchases: purchasesRead(list), overview: over }), 'gold-rewards');
  const none = line([]);
  assert.match(none, /data-state="none"/);
  assert.ok(none.includes(REWARDS_NONE_KEPT));
  assert.doesNotMatch(none, /\$0\.00/);
  const noneRecorded = line([], incomplete);
  assert.match(noneRecorded, /data-state="unknown"/);
  assert.ok(noneRecorded.includes(REWARDS_NONE_RECORDED));
  const partialLine = line([giftCard], incomplete);
  assert.match(partialLine, /data-state="partial"[^>]*>.*>Partial</);
  assert.ok(partialLine.includes(REWARDS_INCOMPLETE));
  assert.match(line([giftCard]), /data-state="complete"/);
  assert.ok(!line([giftCard]).includes(REWARDS_INCOMPLETE));
  const unknownLine = line([purchaseFixture()]);
  assert.match(unknownLine, /data-state="unknown"[^>]*>.*>Unknown</);
  assert.match(unknownLine, /needs each card/);
});
