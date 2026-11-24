import assert from 'node:assert/strict';
import { test } from 'node:test';

import { overviewFixture, purchaseFixture, saleFixture, timelineFixture } from './goldFixtures';
import type { MetalsFunding, MetalsNotInstalled, MetalsOverview, MetalsPurchases, MetalsSales } from './goldApi';
import {
  goldReadFailed, goldReadLanded, goldReadShown, goldReadStarted, goldSectionsBusy, periodCancelled, periodFunding, periodList, periodOverview,
  periodTimeline, periodTrades, type GoldHeldRead, type GoldScope, type GoldTimelineAnswer,
} from './goldReads';

// Synthetic fixtures only. Gold over A (the last 6 months) and over B (all recorded history); A a day on (only its end
// differs); silver over B.
const A: GoldScope = { metal: 'XAU', from: '2026-05-08', to: '2026-11-08' };
const A_NEXT_DAY: GoldScope = { metal: 'XAU', from: '2026-05-08', to: '2026-11-09' };
const B: GoldScope = { metal: 'XAU', from: null, to: '2026-11-08' };
const SILVER_B: GoldScope = { metal: 'XAG', from: null, to: '2026-11-08' };
const NOT_INSTALLED: MetalsNotInstalled = { installed: false };

/** A read holding `answer`: at rest, or with the next read under way (`busy`). */
const held = <T,>(answer: T | null, busy = false): GoldHeldRead<T> => ({ answer, busy });

const overviewOf = (scope: GoldScope): MetalsOverview => {
  const base = overviewFixture({ metal: scope.metal });
  return { ...base, activity: { ...base.activity, from: scope.from, to: scope.to } };
};
const purchasesOf = (scope: GoldScope): MetalsPurchases => ({ installed: true, ...scope, purchases: [purchaseFixture()] });
const salesOf = (scope: GoldScope): MetalsSales => ({ installed: true, ...scope, sales: [saleFixture()] });
const fundingOf = (scope: GoldScope): MetalsFunding => ({ installed: true, from: scope.from, to: scope.to, purchases: [], sales: [], deposits: [] });
const timelineOf = (scope: GoldScope): GoldTimelineAnswer => ({ read: { ...timelineFixture(), metal: scope.metal }, from: scope.from, to: scope.to });

test('a read again keeps its view\'s answer, busy from the render its request changes until its own answer lands', () => {
  const first = goldReadLanded('XAU', 'r1', 'one');
  assert.deepEqual(goldReadShown(first, 'XAU', 'r1'), { answer: 'one', error: null, missing: false, busy: false });
  // The render where the request changes (before the read starts), then the read under way: the answer kept, busy.
  assert.deepEqual(goldReadShown(first, 'XAU', 'r2'), { answer: 'one', error: null, missing: false, busy: true });
  assert.deepEqual(goldReadShown(goldReadStarted(first, 'XAU', 'r2'), 'XAU', 'r2'), { answer: 'one', error: null, missing: false, busy: true });
  assert.deepEqual(goldReadShown(goldReadLanded('XAU', 'r2', 'two'), 'XAU', 'r2'), { answer: 'two', error: null, missing: false, busy: false });
  // Another view (the metal) starts clean; a read that is off shows nothing and isn't busy.
  assert.deepEqual(goldReadShown(goldReadStarted(first, 'XAG', 'r3'), 'XAG', 'r3'), { answer: null, error: null, missing: false, busy: true });
  assert.deepEqual(goldReadShown(first, 'XAG', 'r3'), { answer: null, error: null, missing: false, busy: true });
  assert.deepEqual(goldReadShown(first, 'XAU', null), { answer: null, error: null, missing: false, busy: false });
});

test('a read again that fails keeps no answer: its error, never the answer from before as if current', () => {
  const failed = goldReadFailed<string>('XAU', 'r2', 'Synthetic failure', true);
  assert.deepEqual(goldReadShown(failed, 'XAU', 'r2'), { answer: null, error: 'Synthetic failure', missing: true, busy: false });
  // An older request's error isn't the current one's: busy until its own answer or error.
  assert.deepEqual(goldReadShown(failed, 'XAU', 'r3'), { answer: null, error: null, missing: false, busy: true });
  // So no section is given the answer from before: not the list, nor the trades, nor the cancelled list.
  const purchases = goldReadShown(goldReadFailed<MetalsPurchases>('XAU', 'r2', 'Synthetic failure', false), 'XAU', 'r2');
  const sales = held(salesOf(A));
  assert.equal(periodList(purchases, A), null);
  assert.deepEqual(periodTrades(purchases, sales, A), { purchases: null, sales: sales.answer });
  assert.equal(periodCancelled(purchases, sales, A), null);
  const overview = goldReadShown(goldReadFailed<MetalsOverview>('XAU', 'r2', 'Synthetic failure', false), 'XAU', 'r2');
  assert.equal(periodOverview(overview, A), null);
});

test('a section stays marked as being read again until every read it shows from is in, whichever lands first', () => {
  const idle = { overview: false, purchases: false, sales: false, timeline: false, funding: false };
  assert.deepEqual(goldSectionsBusy(idle), { summary: false, held: false, purchases: false, sales: false, details: false, page: false });
  // One read still under way, each in turn. The overview: the summary and Details' sections as of today, and also what
  // was held and the sales (they show its spot, and what was held its unresolved line), whatever has landed of their own.
  assert.deepEqual(goldSectionsBusy({ ...idle, overview: true }),
    { summary: true, held: true, purchases: false, sales: true, details: true, page: true });
  assert.deepEqual(goldSectionsBusy({ ...idle, purchases: true }),
    { summary: false, held: false, purchases: true, sales: false, details: false, page: true });
  assert.deepEqual(goldSectionsBusy({ ...idle, sales: true }),
    { summary: false, held: false, purchases: false, sales: true, details: false, page: true });
  assert.deepEqual(goldSectionsBusy({ ...idle, timeline: true }),
    { summary: false, held: true, purchases: false, sales: false, details: false, page: true });
  // The funding read (the receipts, in the purchases section).
  assert.deepEqual(goldSectionsBusy({ ...idle, funding: true }),
    { summary: false, held: false, purchases: true, sales: false, details: false, page: true });
});

test('the period\'s figures come only from an overview that answers the metal and period chosen, never the period before', () => {
  const overviewA = overviewOf(A);
  assert.equal(periodOverview(held(overviewA), A), overviewA);
  // A delayed read: B is chosen and its read is under way, so the overview still answers A. Nothing speaks for B.
  assert.equal(periodOverview(held(overviewA, true), B), null);
  // A period mismatch, even at rest: A's answer never speaks for B, nor B's for A; one day on is another period.
  assert.equal(periodOverview(held(overviewA), B), null);
  assert.equal(periodOverview(held(overviewOf(B)), A), null);
  assert.equal(periodOverview(held(overviewA), A_NEXT_DAY), null);
  // A metal mismatch: gold's answer never speaks for silver.
  assert.equal(periodOverview(held(overviewOf(B)), SILVER_B), null);
  // A read again after a write: A's own answer stays (the page marks it updating).
  assert.equal(periodOverview(held(overviewA, true), A), overviewA);
  // Nothing read yet, or no metals tables: nothing.
  assert.equal(periodOverview(held<MetalsOverview>(null, true), A), null);
  assert.equal(periodOverview(held(NOT_INSTALLED), A), null);
});

test('each list (purchases, sales) shows only an answer for the metal and period chosen', () => {
  for (const [name, of] of [['purchases', purchasesOf], ['sales', salesOf]] as const) {
    const listA = of(A);
    assert.equal(periodList(held(listA), A), listA, name);
    // A delayed read: B chosen, its read under way, A still held.
    assert.equal(periodList(held(listA, true), B), null, name);
    // A period mismatch at rest, either way and a day on.
    assert.equal(periodList(held(listA), B), null, name);
    assert.equal(periodList(held(of(B)), A), null, name);
    assert.equal(periodList(held(listA), A_NEXT_DAY), null, name);
    // A metal mismatch.
    assert.equal(periodList(held(of(B)), SILVER_B), null, name);
    // A read again after a write: A's own rows stay (marked updating), so an opened row and its focus stay too.
    assert.equal(periodList(held(listA, true), A), listA, name);
  }
  assert.equal(periodList<MetalsPurchases>(held(NOT_INSTALLED), A), null);
  assert.equal(periodList(held<MetalsSales>(null, true), A), null);
});

test('the receipts show only a funding answer for the period chosen, the same for every metal', () => {
  const fundingA = fundingOf(A);
  assert.equal(periodFunding(held(fundingA), A), fundingA);
  assert.equal(periodFunding(held(fundingA), { ...A, metal: 'XAG' }), fundingA);
  // A delayed read, and a period mismatch at rest, either way and a day on.
  assert.equal(periodFunding(held(fundingA, true), B), null);
  assert.equal(periodFunding(held(fundingA), B), null);
  assert.equal(periodFunding(held(fundingOf(B)), A), null);
  assert.equal(periodFunding(held(fundingA), A_NEXT_DAY), null);
  assert.equal(periodFunding(held(fundingA, true), A), fundingA);
  assert.equal(periodFunding(held(NOT_INSTALLED), A), null);
});

test('what was held shows only a timeline read for the metal and period chosen (the period the page asked it for)', () => {
  const timelineA = timelineOf(A);
  assert.equal(periodTimeline(held(timelineA), A), timelineA.read);
  // A delayed read: B chosen (a longer history), A's shorter one still held: never drawn under B's dates.
  assert.equal(periodTimeline(held(timelineA, true), B), null);
  assert.equal(periodTimeline(held(timelineA), B), null);
  assert.equal(periodTimeline(held(timelineOf(B)), A), null);
  assert.equal(periodTimeline(held(timelineA), A_NEXT_DAY), null);
  // A metal mismatch.
  assert.equal(periodTimeline(held(timelineOf(B)), SILVER_B), null);
  assert.equal(periodTimeline(held(timelineA, true), A), timelineA.read);
  assert.equal(periodTimeline(held({ read: NOT_INSTALLED, from: A.from, to: A.to }), A), null);
  assert.equal(periodTimeline(held<GoldTimelineAnswer>(null, true), A), null);
});

test('the price chart\'s trades: neither while either read is under way, whichever lands first; then each that answers the period', () => {
  const [purchasesA, purchasesB, salesA, salesB] = [purchasesOf(A), purchasesOf(B), salesOf(A), salesOf(B)];
  const none = { purchases: null, sales: null };
  // B chosen: purchases land first while sales still hold A, then the other way round. Nothing drawn yet.
  assert.deepEqual(periodTrades(held(purchasesB), held(salesA, true), B), none);
  assert.deepEqual(periodTrades(held(purchasesA, true), held(salesB), B), none);
  // Both in for B.
  assert.deepEqual(periodTrades(held(purchasesB), held(salesB), B), { purchases: purchasesB, sales: salesB });
  // B read again after a write, one read back first: never two moments drawn together.
  assert.deepEqual(periodTrades(held(purchasesB), held(salesB, true), B), none);
  assert.deepEqual(periodTrades(held(purchasesB, true), held(salesB), B), none);
  // At rest, a read answering another period or metal is never drawn; a read that failed has no answer (the chart says so).
  assert.deepEqual(periodTrades(held(purchasesA), held(salesB), B), { purchases: null, sales: salesB });
  assert.deepEqual(periodTrades(held(purchasesB), held(salesOf(SILVER_B)), B), { purchases: purchasesB, sales: null });
  assert.deepEqual(periodTrades(held<MetalsPurchases>(null), held(salesB), B), { purchases: null, sales: salesB });
});

test('the cancelled list, counted over both reads: only with neither under way and both answering the metal and period', () => {
  const [purchasesA, purchasesB, salesA, salesB] = [purchasesOf(A), purchasesOf(B), salesOf(A), salesOf(B)];
  // B chosen, either read landing first: no list yet.
  assert.equal(periodCancelled(held(purchasesB), held(salesA, true), B), null);
  assert.equal(periodCancelled(held(purchasesA, true), held(salesB), B), null);
  assert.deepEqual(periodCancelled(held(purchasesB), held(salesB), B), { purchases: purchasesB, sales: salesB });
  // B read again after a write, one read back first.
  assert.equal(periodCancelled(held(purchasesB, true), held(salesB), B), null);
  assert.equal(periodCancelled(held(purchasesB), held(salesB, true), B), null);
  // At rest: another period, another metal, or a read that failed: no list, never a count over one read alone.
  assert.equal(periodCancelled(held(purchasesA), held(salesB), B), null);
  assert.equal(periodCancelled(held(purchasesB), held(salesOf(SILVER_B)), B), null);
  assert.equal(periodCancelled(held<MetalsPurchases>(null), held(salesB), B), null);
  assert.equal(periodCancelled(held(purchasesB), held<MetalsSales>(null), B), null);
});
