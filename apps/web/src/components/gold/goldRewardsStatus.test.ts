import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NO_REWARD_ANSWERS } from '@finance-tracker/shared/metals-rewards';

import { complete, overviewFixture, partial, purchaseFixture, unknown } from './goldFixtures';
import type { MetalsPurchase, MetalsPurchases } from './goldApi';
import {
  REWARD_QUESTION_ORDER, REWARD_QUESTION_WORDS, periodPurchasesComplete, rewardOrdersOf, rewardsReadsCurrent, rewardsStatus, sameRewardsPeriod,
} from './goldRewardsStatus';

// Synthetic fixtures and rates only.
const read = (purchases: MetalsPurchase[]): MetalsPurchases => ({ installed: true, metal: 'XAU', from: null, to: '2026-11-08', purchases });
const walmart = (patch: Partial<MetalsPurchase> = {}) => purchaseFixture({
  key: 'walmart-line-a', orderKey: 'walmart-order-a', account: { accountId: 'mtl-acct-wm', source: 'walmart', label: 'Walmart 1' }, ...patch,
});
/** A proof-linked charge of `amountMinor` on the synthetic card `cardId`, its own card row `row` (by default one per card). */
const linkedCard = (cardId: string, amountMinor: number, row: string = cardId): MetalsPurchase['cards'][number] => ({
  ...purchaseFixture().cards[0], amountMinor, row: { id: `card-txn-${row}`, date: '2026-03-11', account: { id: cardId, name: 'Sample Card', ending: '3333' } },
});
const rateOf = (cardId: string, basisPoints: number) => ({ ...NO_REWARD_ANSWERS, cardRates: new Map([[cardId, basisPoints]]) });
const cancelledUnits = { ordered: 1, cancelled: 1, returned: 0, delivered: 0, awaiting: 0 };

test('each order is read once, its units kept or on the way only; a card is the one its exact charge is proof-linked to', () => {
  const lotA = purchaseFixture();
  const lotB = purchaseFixture({ key: 'costco-line-bbbb', costMinor: complete(50_000) });
  const cancelled = purchaseFixture({ key: 'costco-line-cccc', orderKey: 'costco-order-cccc', units: cancelledUnits, delivery: { state: 'cancelled', date: null } });
  const orders = rewardOrdersOf(read([lotA, lotB, cancelled]));
  assert.equal(orders.length, 1);
  // Payments as stated. The part that counts is the kept cost (250,000) over what the order came to (200,000), at most
  // all of it; the yearly basis is the lesser of the two.
  assert.deepEqual(orders[0], {
    key: 'costco-order-aaaa',
    payments: [{ kind: 'card', amountMinor: 200_000, cardId: 'card-acct-aaaa' }],
    share: { keptMinor: 200_000, paidMinor: 200_000 },
    costco: { membershipId: 'mtl-acct-aaaa', year: null, eligibleMinor: 200_000 },
  });
});

test('a Costco order\'s yearly basis is net of its refunds: the lesser of its kept cost and what it came to, never below zero', () => {
  const charge = purchaseFixture().funding[0];
  // A partial refund (a price adjustment, say) of $300.00 on a kept $2,000.00 lot: the basis is what was finally paid.
  const adjusted = purchaseFixture({ funding: [charge, { kind: 'card-refund', network: charge.network, amountMinor: 30_000 }] });
  assert.equal(rewardOrdersOf(read([adjusted]))[0].costco?.eligibleMinor, 170_000);
  // Refunded in full: nothing counts toward the year, never less than nothing.
  const refundedWhole = purchaseFixture({ funding: [charge, { kind: 'card-refund', network: charge.network, amountMinor: 200_000 }] });
  assert.equal(rewardOrdersOf(read([refundedWhole]))[0].costco?.eligibleMinor, 0);
  // Another line's refund leaves this metal's kept cost whole while the order still came to at least that.
  const otherLineRefunded = purchaseFixture({ funding: [{ ...charge, amountMinor: 300_000 }, { kind: 'card-refund', network: charge.network, amountMinor: 50_000 }] });
  assert.equal(rewardOrdersOf(read([otherLineRefunded]))[0].costco?.eligibleMinor, 200_000);
  // A cost or an amount not known: the basis waits.
  assert.equal(rewardOrdersOf(read([purchaseFixture({ costMinor: unknown(['conflict', 1]) })]))[0].costco?.eligibleMinor, null);
  assert.equal(rewardOrdersOf(read([purchaseFixture({ funding: [{ ...charge, amountMinor: null }] })]))[0].costco?.eligibleMinor, null);
  // A refund the source shows that the payments don't carry: what it reverses can't be told, so the basis waits too.
  const [shownOnly] = rewardOrdersOf(read([purchaseFixture({ refunds: [{ amountMinor: -30_000, date: '2026-03-20' }] })]));
  assert.equal(shownOnly.costco?.eligibleMinor, null);
  assert.deepEqual(shownOnly.waits, ['refund-card-unknown']);
});

test('every question the estimate can wait for is asked, in one fixed order', () => {
  assert.deepEqual([...REWARD_QUESTION_ORDER].sort(), Object.keys(REWARD_QUESTION_WORDS).sort());
  assert.equal(new Set(REWARD_QUESTION_ORDER).size, REWARD_QUESTION_ORDER.length);
});

test('a card payment with no proof-linked charge of its exact amount is an unknown card, never a guess', () => {
  const unlinked = walmart({ cards: [], funding: [{ kind: 'card', network: 'amex', amountMinor: 120_000 }] });
  const mismatched = walmart({ key: 'walmart-line-b', orderKey: 'walmart-order-b', funding: [{ kind: 'card', network: 'visa', amountMinor: 1 }] });
  const orders = rewardOrdersOf(read([unlinked, mismatched]));
  assert.deepEqual(orders.map((order) => order.payments[0].cardId), [null, null]);
  assert.deepEqual(orders.map((order) => order.costco), [null, null]);
});

test('an order counts at this metal\'s kept share: another line\'s part and a returned lot earn nothing here', () => {
  // A gold lot of $2,000.00 in an order paid $3,000.00 by one card (another line paid the rest): two thirds of the charge.
  const mixed = walmart({ costMinor: complete(200_000), cards: [], funding: [{ kind: 'card', network: 'visa', amountMinor: 300_000 }] });
  const [order] = rewardOrdersOf(read([mixed]));
  assert.deepEqual(order.payments, [{ kind: 'card', amountMinor: 300_000, cardId: null }]);
  assert.deepEqual(order.share, { keptMinor: 200_000, paidMinor: 300_000 });
  // Two lots, one returned and refunded: the refund nets what the order came to down to the kept lot's cost.
  const keptLot = walmart({ key: 'walmart-line-k', orderKey: 'walmart-order-r', costMinor: complete(200_000), cards: [],
    funding: [{ kind: 'card', network: 'visa', amountMinor: 300_000 }, { kind: 'card-refund', network: 'visa', amountMinor: 100_000 }] });
  const returnedLot = { ...keptLot, key: 'walmart-line-x', costMinor: complete(100_000),
    units: { ordered: 1, cancelled: 0, returned: 1, delivered: 0, awaiting: 0 }, delivery: { state: 'returned' as const, date: '2026-03-20' } };
  const [returned] = rewardOrdersOf(read([keptLot, returnedLot]));
  assert.deepEqual(returned.payments, [{ kind: 'card', amountMinor: 300_000, cardId: null }, { kind: 'card', amountMinor: -100_000, cardId: null, reverses: null }]);
  assert.deepEqual(returned.share, { keptMinor: 200_000, paidMinor: 200_000 });
  // A cost that isn't complete, unknown or partial with a number (its order's costs not attributed), or one below zero (a
  // coupon above its item's price), leaves the share untold: the order waits for the cost, never a share of a partial or
  // negative figure, and the page never throws (5b01e72f; G1d's D-P2-1).
  for (const costMinor of [unknown<number>(['conflict', 1]), partial(200_000, ['cost-unattributed', 1]), complete(-500)]) {
    const [waiting] = rewardOrdersOf(read([walmart({ costMinor, cards: [], funding: [{ kind: 'card', network: 'visa', amountMinor: 300_000 }] })]));
    assert.equal(waiting.share, null);
    assert.deepEqual(waiting.waits, ['cost-incomplete']);
    const status = rewardsStatus(read([walmart({ costMinor, cards: [linkedCard('card-acct-cccc', 300_000)],
      funding: [{ kind: 'card', network: 'visa', amountMinor: 300_000 }] })]), rateOf('card-acct-cccc', 200), true);
    assert.deepEqual(status.figure, { minor: null, questions: ['cost-incomplete'] });
    assert.deepEqual(status.needs, ['the full cost assigned to each purchase']);
  }
});

test('a coupon repeats the discount its cost already carries: it never counts as paying (5b01e72f)', () => {
  // Kept cost $90.00 after a $10.00 coupon; the card, proof-linked, charged $90.00: 2% of all of it, 180 cents (never 162).
  const couponed = walmart({ costMinor: complete(9_000), cards: [linkedCard('card-acct-cccc', 9_000)],
    funding: [{ kind: 'card', network: 'visa', amountMinor: 9_000 }, { kind: 'coupon', network: 'unknown', amountMinor: 1_000 }] });
  assert.deepEqual(rewardOrdersOf(read([couponed]))[0].share, { keptMinor: 9_000, paidMinor: 9_000 });
  assert.deepEqual(rewardsStatus(read([couponed]), rateOf('card-acct-cccc', 200), true).figure, { minor: 180, questions: [] });
  // A Shop Card or a gift card still pays: only the coupon is left out.
  const giftCard = walmart({ costMinor: complete(9_000), cards: [linkedCard('card-acct-cccc', 6_000)],
    funding: [{ kind: 'card', network: 'visa', amountMinor: 6_000 }, { kind: 'gift-card', network: 'unknown', amountMinor: 3_000 }] });
  assert.deepEqual(rewardOrdersOf(read([giftCard]))[0].share, { keptMinor: 9_000, paidMinor: 9_000 });
  assert.deepEqual(rewardsStatus(read([giftCard]), rateOf('card-acct-cccc', 200), true).figure, { minor: 120, questions: [] });
  // Paid by coupon alone: nothing was paid, so a known 0 whatever the rates, never "how some orders were paid".
  const couponOnly = walmart({ costMinor: complete(0), cards: [], funding: [{ kind: 'coupon', network: 'unknown', amountMinor: 1_000 }] });
  assert.deepEqual(rewardsStatus(read([couponOnly]), NO_REWARD_ANSWERS, true).figure, { minor: 0, questions: [] });
});

test('a lot partly returned or cancelled counts its kept units alone, at their cost (5b01e72f; the lead\'s rule 1)', () => {
  // Two units for $10.00, one returned and one kept, charged $10.00 at 2% with no refund credit yet: the kept unit's 10 cents.
  const half = walmart({ quantity: 2, units: { ordered: 2, cancelled: 0, returned: 1, delivered: 1, awaiting: 0 }, costMinor: complete(1_000),
    cards: [linkedCard('card-acct-cccc', 1_000)], funding: [{ kind: 'card', network: 'visa', amountMinor: 1_000 }] });
  assert.deepEqual(rewardOrdersOf(read([half]))[0].share, { keptMinor: 500, paidMinor: 1_000 });
  assert.deepEqual(rewardsStatus(read([half]), rateOf('card-acct-cccc', 200), true).figure, { minor: 10, questions: [] });
  // An odd cent belongs to the earlier unit, the kept one (the ledger numbers kept units first); on the way counts as kept.
  const odd = walmart({ quantity: 2, units: { ordered: 2, cancelled: 1, returned: 0, delivered: 0, awaiting: 1 }, costMinor: complete(1_001),
    cards: [], funding: [{ kind: 'card', network: 'visa', amountMinor: 1_001 }] });
  assert.deepEqual(rewardOrdersOf(read([odd]))[0].share, { keptMinor: 501, paidMinor: 1_001 });
});

test('with no rate stored, the estimate is unknown and says what each card and membership needs', () => {
  const status = rewardsStatus(read([
    purchaseFixture(),
    walmart({ cards: [], funding: [{ kind: 'card', network: 'amex', amountMinor: 120_000 }] }),
    walmart({ key: 'walmart-line-s', orderKey: 'walmart-order-s', cards: [], funding: [{ kind: 'shop-card', network: 'unknown', amountMinor: 10_000 }] }),
  ]));
  assert.equal(status.figure.minor, null);
  assert.deepEqual(status.figure.questions, ['card-rate-needed', 'membership-rate-needed', 'card-unknown', 'shop-card-buyer-unknown']);
  // Asked in one fixed order (cards first, then Costco), whatever order the purchases come in.
  assert.deepEqual(status.needs, (['card-rate-needed', 'card-unknown', 'shop-card-buyer-unknown', 'membership-rate-needed'] as const)
    .map((question) => REWARD_QUESTION_WORDS[question]));
  const reversed = rewardsStatus(read([
    walmart({ key: 'walmart-line-s', orderKey: 'walmart-order-s', cards: [], funding: [{ kind: 'shop-card', network: 'unknown', amountMinor: 10_000 }] }),
    walmart({ cards: [], funding: [{ kind: 'card', network: 'amex', amountMinor: 120_000 }] }),
    purchaseFixture(),
  ]));
  assert.deepEqual(reversed.needs, status.needs);
  assert.deepEqual(status.cards.map((card) => [card.account.id, card.orders, card.chargedMinor]), [['card-acct-aaaa', 1, 200_000]]);
  assert.deepEqual(status.unlinked, [{ network: 'amex', orders: 1 }]);
  assert.deepEqual(status.costcoMemberships, [{ accountId: 'mtl-acct-aaaa', label: 'Costco membership 1', orders: 1 }]);
  assert.equal(status.shopCardOrders, 1);
});

test('given synthetic answers, the estimate is the card\'s rate on its charge plus the membership\'s share, never a network-wide rate', () => {
  const answers = {
    ...NO_REWARD_ANSWERS,
    cardRates: new Map([['card-acct-aaaa', 150]]),
    memberships: new Map([['mtl-acct-aaaa', { basisPoints: 200, metalsEligible: false, capMinor: 125_000 }]]),
  };
  assert.deepEqual(rewardsStatus(read([purchaseFixture()]), answers).figure, { minor: 3_000, questions: [] });
  // A second Visa card the owner hasn't answered keeps the estimate unknown, whatever the first card's rate.
  const other = walmart({ cards: [{ ...purchaseFixture().cards[0], amountMinor: 50_000, row: { id: 'card-txn-b', date: '2026-03-11', account: { id: 'card-acct-bbbb', name: 'Other Visa', ending: '2222' } } }],
    funding: [{ kind: 'card', network: 'visa', amountMinor: 50_000 }] });
  assert.deepEqual(rewardsStatus(read([purchaseFixture(), other]), answers).figure, { minor: null, questions: ['card-rate-needed'] });
});

test('a refund reverses only when proven tied to its charge on the same card: refunds never link, so the estimate waits', () => {
  const charge = purchaseFixture().funding[0];
  const refunded = purchaseFixture({ funding: [charge, { kind: 'card-refund', network: charge.network, amountMinor: 50_000 }] });
  const [order] = rewardOrdersOf(read([refunded]));
  assert.deepEqual(order.payments, [
    { kind: 'card', amountMinor: 200_000, cardId: 'card-acct-aaaa' },
    { kind: 'card', amountMinor: -50_000, cardId: null, reverses: null },
  ]);
  const answers = {
    ...NO_REWARD_ANSWERS,
    cardRates: new Map([['card-acct-aaaa', 150]]),
    memberships: new Map([['mtl-acct-aaaa', { basisPoints: 200, metalsEligible: false, capMinor: 125_000 }]]),
  };
  const status = rewardsStatus(read([refunded]), answers);
  assert.deepEqual(status.figure, { minor: null, questions: ['refund-card-unknown'] });
  assert.deepEqual(status.needs, ['which original charge on the same card each refund reverses']);
  assert.deepEqual(status.unlinked, []);
  // A refund the source shows that the payments don't carry waits the same way.
  assert.deepEqual(rewardsStatus(read([purchaseFixture({ refunds: [{ amountMinor: -50_000, date: '2026-03-20' }] })]), answers).figure,
    { minor: null, questions: ['refund-card-unknown'] });
});

test('no purchase kept or on the way: words, never "$0.00"; unknown while the period\'s purchases aren\'t complete (G1d\'s P1)', () => {
  const none = rewardsStatus(read([]), NO_REWARD_ANSWERS, true);
  assert.equal(none.state, 'none');
  assert.equal(none.orders, 0);
  assert.equal(rewardsStatus(read([]), NO_REWARD_ANSWERS, false).state, 'unknown');
  // Only a cancelled lot in the period: none kept, the same.
  const cancelled = purchaseFixture({ units: cancelledUnits, delivery: { state: 'cancelled', date: null } });
  assert.equal(rewardsStatus(read([cancelled]), NO_REWARD_ANSWERS, true).state, 'none');
  // An order held for an answer is in no list. Held in the period, it is counted in Bought's cost (`source-held`): the
  // period's purchases aren't complete, so no figure is either.
  const base = overviewFixture();
  const heldHere = { ...base, activity: { ...base.activity, bought: { ...base.activity.bought, costMinor: partial(200_000, ['source-held', 1]) } } };
  assert.equal(periodPurchasesComplete(heldHere), false);
  assert.equal(rewardsStatus(read([]), NO_REWARD_ANSWERS, periodPurchasesComplete(heldHere)).state, 'unknown');
});

test('the line pairs the purchases and the overview only when both answer the same metal and period (5b01e72f\'s N9)', () => {
  const answering = (from: string | null, to: string) => {
    const overview = overviewFixture();
    return { ...overview, activity: { ...overview.activity, from, to } };
  };
  const purchasesOf = (from: string | null, to: string): MetalsPurchases => ({ installed: true, metal: 'XAU', from, to, purchases: [] });
  assert.equal(sameRewardsPeriod(purchasesOf('2026-05-08', '2026-11-08'), answering('2026-05-08', '2026-11-08')), true);
  assert.equal(sameRewardsPeriod(purchasesOf(null, '2026-11-08'), answering(null, '2026-11-08')), true);
  // After a change of period, either read can still answer the period before while the other is current: never paired.
  assert.equal(sameRewardsPeriod(purchasesOf('2026-10-08', '2026-11-08'), answering('2026-05-08', '2026-11-08')), false);
  assert.equal(sameRewardsPeriod(purchasesOf('2026-05-08', '2026-11-08'), answering('2026-10-08', '2026-11-08')), false);
  assert.equal(sameRewardsPeriod(purchasesOf('2026-05-08', '2026-11-08'), answering('2026-05-08', '2026-11-09')), false);
  // Another metal's read never pairs either.
  assert.equal(sameRewardsPeriod({ ...purchasesOf('2026-05-08', '2026-11-08'), metal: 'XAG' }, answering('2026-05-08', '2026-11-08')), false);
  // And both must be current: right after a change of period both still answer the period before (the dates agree, both
  // under way), and a refresh of the same period can leave one read older: either under way, the line waits.
  const samePurchases = purchasesOf('2026-05-08', '2026-11-08');
  const sameOverview = answering('2026-05-08', '2026-11-08');
  assert.equal(rewardsReadsCurrent(samePurchases, sameOverview, { purchases: false, overview: false }), true);
  assert.equal(rewardsReadsCurrent(samePurchases, sameOverview, { purchases: true, overview: true }), false);
  assert.equal(rewardsReadsCurrent(samePurchases, sameOverview, { purchases: true, overview: false }), false);
  assert.equal(rewardsReadsCurrent(samePurchases, sameOverview, { purchases: false, overview: true }), false);
  assert.equal(rewardsReadsCurrent(purchasesOf('2026-10-08', '2026-11-08'), sameOverview, { purchases: false, overview: false }), false);
});

test('a known figure over a period whose purchases aren\'t all counted is partial, never presented as whole (G1d\'s P1)', () => {
  const answers = {
    ...NO_REWARD_ANSWERS,
    cardRates: new Map([['card-acct-aaaa', 150]]),
    memberships: new Map([['mtl-acct-aaaa', { basisPoints: 200, metalsEligible: false, capMinor: 125_000 }]]),
  };
  const status = (complete: boolean) => rewardsStatus(read([purchaseFixture()]), answers, complete);
  assert.deepEqual([status(true).state, status(true).incomplete], ['complete', false]);
  assert.deepEqual([status(false).state, status(false).incomplete, status(false).figure.minor], ['partial', true, 3_000]);
  assert.equal(rewardsStatus(read([purchaseFixture()]), NO_REWARD_ANSWERS, true).state, 'unknown');
  // Complete only when what was bought in the period is complete. Bought's cost carries the period's own holds (buy-side
  // holds dated in it, and undated open ones: proven on the API side); `needsAnswer` lists every held order whatever its
  // date, so an order held at another date doesn't withhold the period (5b01e72f).
  const base = overviewFixture();
  const withBought = (costMinor: typeof base.activity.bought.costMinor, held = 0) => ({
    ...base, activity: { ...base.activity, bought: { ...base.activity.bought, costMinor } }, needsAnswer: { ...base.needsAnswer, orders: held },
  });
  assert.equal(periodPurchasesComplete(withBought(complete(200_000))), true);
  const heldElsewhere = withBought(complete(200_000), 1);
  assert.equal(periodPurchasesComplete(heldElsewhere), true);
  assert.equal(rewardsStatus(read([purchaseFixture()]), answers, periodPurchasesComplete(heldElsewhere)).state, 'complete');
  assert.equal(periodPurchasesComplete(withBought(partial(200_000, ['source-held', 1]), 1)), false);
  assert.equal(periodPurchasesComplete(withBought(partial(200_000, ['source-held', 1]))), false);
  assert.equal(periodPurchasesComplete(withBought(unknown<number>(['source-held', 1]), 1)), false);
  assert.equal(periodPurchasesComplete(withBought(unknown<number>(['conflict', 1]))), false);
});

test('a card adds every charge the estimate matched to it, its order once; a linked charge no payment matched pays for nothing (PR-R)', () => {
  const cardsOf = (status: ReturnType<typeof rewardsStatus>) => status.cards.map((card) => [card.account.id, card.orders, card.chargedMinor]);
  // Two charges on one card in one order, each its own card row: both count, the order once.
  const split = purchaseFixture({
    funding: [{ kind: 'card', network: 'visa', amountMinor: 120_000 }, { kind: 'card', network: 'visa', amountMinor: 80_000 }],
    cards: [linkedCard('card-acct-aaaa', 120_000, 'aaaa-1'), linkedCard('card-acct-aaaa', 80_000, 'aaaa-2')],
  });
  assert.deepEqual(cardsOf(rewardsStatus(read([split]))), [['card-acct-aaaa', 1, 200_000]]);
  // Another order on the same card is its second order.
  const another = walmart({ cards: [linkedCard('card-acct-aaaa', 50_000, 'aaaa-3')], funding: [{ kind: 'card', network: 'visa', amountMinor: 50_000 }] });
  assert.deepEqual(cardsOf(rewardsStatus(read([split, another]))), [['card-acct-aaaa', 2, 250_000]]);
  // A linked charge whose amount no stated payment has isn't a paying card; the payment it didn't match is an unknown card.
  const stray = walmart({ cards: [linkedCard('card-acct-bbbb', 49_999, 'bbbb-1')], funding: [{ kind: 'card', network: 'amex', amountMinor: 50_000 }] });
  assert.deepEqual(cardsOf(rewardsStatus(read([stray]))), []);
  assert.deepEqual(rewardsStatus(read([stray])).unlinked, [{ network: 'amex', orders: 1 }]);
  // Beside a matched charge, an extra linked one isn't listed either.
  const extra = purchaseFixture({ cards: [...purchaseFixture().cards, linkedCard('card-acct-bbbb', 999, 'bbbb-2')] });
  assert.deepEqual(cardsOf(rewardsStatus(read([extra]))), [['card-acct-aaaa', 1, 200_000]]);
});

test('an order\'s unlinked charges count it once per network; refunds and other tenders never count (PR-R)', () => {
  const twice = walmart({ cards: [], funding: [{ kind: 'card', network: 'visa', amountMinor: 60_000 }, { kind: 'card', network: 'visa', amountMinor: 40_000 }] });
  assert.deepEqual(rewardsStatus(read([twice])).unlinked, [{ network: 'visa', orders: 1 }]);
  // A refund to a network no charge of the order used, and a Shop Card payment: neither is an unlinked charge.
  const mixed = walmart({
    key: 'walmart-line-m', orderKey: 'walmart-order-m', cards: [], funding: [
      { kind: 'card', network: 'visa', amountMinor: 30_000 }, { kind: 'card', network: 'amex', amountMinor: 20_000 },
      { kind: 'card-refund', network: 'discover', amountMinor: 5_000 }, { kind: 'shop-card', network: 'mastercard', amountMinor: 1_000 },
    ],
  });
  assert.deepEqual(rewardsStatus(read([twice, mixed])).unlinked, [{ network: 'visa', orders: 2 }, { network: 'amex', orders: 1 }]);
  // An order whose only card payment is a refund lists no network.
  const refundOnly = walmart({ key: 'walmart-line-r', orderKey: 'walmart-order-r', cards: [], funding: [{ kind: 'card-refund', network: 'discover', amountMinor: 5_000 }] });
  assert.deepEqual(rewardsStatus(read([refundOnly])).unlinked, []);
});
