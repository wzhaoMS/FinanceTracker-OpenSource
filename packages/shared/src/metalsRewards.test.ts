import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_REWARD_ANSWERS,
  costcoRewardShares,
  estimatedRewards,
  keptUnitsCost,
  lotRewards,
  membershipYearKey,
  orderCardReward,
  orderRewards,
  rewardOn,
  rewardPaymentKind,
  splitProportionally,
  sumRewardFigures,
  withMatchedRewards,
  type MetalsRewardAnswers,
  type MetalsRewardLot,
  type MetalsRewardOrder,
} from './metalsRewards.js';

// Synthetic rates and amounts only: every card id, membership and figure here is made up for the test.
const answers = (patch: Partial<MetalsRewardAnswers> = {}): MetalsRewardAnswers => ({ ...NO_REWARD_ANSWERS, ...patch });
const card = (cardId: string | null, amountMinor: number | null) => ({ kind: 'card' as const, amountMinor, cardId });
/** A refund (a negative card payment) gone back to `cardId`, proven to reverse the order's payment at `reverses` (null: unproven). */
const refund = (cardId: string | null, amountMinor: number, reverses: number | null = 0) => ({ kind: 'card' as const, amountMinor, cardId, reverses });
const order = (key: string, payments: MetalsRewardOrder['payments'], costco: MetalsRewardOrder['costco'] = null): MetalsRewardOrder =>
  ({ key, payments, costco });

describe('metals rewards: arithmetic', () => {
  it('a rate on an amount rounds to the cent, half away from zero', () => {
    assert.equal(rewardOn(100_000, 150), 1_500);
    assert.equal(rewardOn(333, 150), 5); // 4.995 cents
    assert.equal(rewardOn(330, 150), 5); // 4.95 cents
    assert.equal(rewardOn(329, 150), 5); // 4.935 cents
    assert.equal(rewardOn(-333, 150), -5);
    assert.equal(rewardOn(0, 200), 0);
  });

  it('a proportional split always adds up to the total; ties go to the earlier weight', () => {
    assert.deepEqual(splitProportionally(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(splitProportionally(10, [3, 7]), [3, 7]);
    assert.deepEqual(splitProportionally(7, [0, 0]), [0, 0]);
    for (const [total, weights] of [[1_001, [5, 3, 2]], [99, [1, 2, 3, 4]], [1, [1, 1]]] as const) {
      assert.equal(splitProportionally(total, weights).reduce((a, b) => a + b, 0), total);
    }
  });
});

describe('metals rewards: cards', () => {
  it('a card earns its own rate on the amount it charged', () => {
    const rates = answers({ cardRates: new Map([['card-a', 150], ['card-b', 300]]) });
    assert.deepEqual(orderCardReward(order('o1', [card('card-a', 100_000)]), rates), { minor: 1_500, questions: [] });
    assert.deepEqual(orderCardReward(order('o2', [card('card-a', 60_000), card('card-b', 40_000)]), rates), { minor: 900 + 1_200, questions: [] });
  });

  it('a rate is per card, never one rate for every card of a network: an unanswered card stays a question', () => {
    const rates = answers({ cardRates: new Map([['card-a', 150]]) });
    assert.deepEqual(orderCardReward(order('o1', [card('card-a', 100_000), card('card-c', 50_000)]), rates),
      { minor: null, questions: ['card-rate-needed'] });
  });

  it('a payment by Shop Card earns the rate of the card that bought the Shop Card; an unknown buyer is a question', () => {
    const rates = answers({ cardRates: new Map([['card-a', 200]]) });
    assert.deepEqual(orderCardReward(order('o1', [{ kind: 'shop-card', amountMinor: 50_000, cardId: 'card-a' }]), rates),
      { minor: 1_000, questions: [] });
    assert.deepEqual(orderCardReward(order('o2', [{ kind: 'shop-card', amountMinor: 50_000, cardId: null }]), rates),
      { minor: null, questions: ['shop-card-buyer-unknown'] });
  });

  it('an unknown card, an unstated amount or no payment at all is a question, never zero; a no-reward tender is a known zero', () => {
    const rates = answers({ cardRates: new Map([['card-a', 200]]) });
    assert.deepEqual(orderCardReward(order('o1', [card(null, 10_000)]), rates), { minor: null, questions: ['card-unknown'] });
    assert.deepEqual(orderCardReward(order('o2', [card('card-a', null)]), rates), { minor: null, questions: ['payment-not-stated'] });
    assert.deepEqual(orderCardReward(order('o3', []), rates), { minor: null, questions: ['payment-not-stated'] });
    assert.deepEqual(orderCardReward(order('o4', [{ kind: 'no-reward', amountMinor: 10_000, cardId: null }]), rates), { minor: 0, questions: [] });
  });

  it('a refund reverses only its own charge, proven on that charge\'s card, at the charge\'s rate', () => {
    const rates = answers({ cardRates: new Map([['card-a', 150], ['card-b', 300]]) });
    // A proven partial refund takes back the charge's reward on what it refunded: 1.5% of the 60,000 left.
    assert.deepEqual(orderCardReward(order('o1', [card('card-a', 100_000), refund('card-a', -40_000)]), rates), { minor: 900, questions: [] });
    // Not proven tied to its charge, or gone back to another card: the order waits, whatever the rates.
    for (const unproven of [refund(null, -40_000, null), refund('card-a', -40_000, null), refund('card-b', -40_000)]) {
      assert.deepEqual(orderCardReward(order('o2', [card('card-a', 100_000), unproven]), rates), { minor: null, questions: ['refund-card-unknown'] });
    }
    // Nor does one reverse a payment that isn't a charge on a known card: a Shop Card payment, a charge whose card isn't
    // known, another refund, or itself.
    assert.deepEqual(orderCardReward(order('o3', [{ kind: 'shop-card', amountMinor: 10_000, cardId: 'card-a' }, refund('card-a', -1_000)]), rates),
      { minor: null, questions: ['refund-card-unknown'] });
    assert.deepEqual(orderCardReward(order('o4', [card(null, 10_000), refund(null, -1_000)]), rates), { minor: null, questions: ['card-unknown', 'refund-card-unknown'] });
    assert.deepEqual(orderCardReward(order('o5', [card('card-a', 10_000), refund('card-a', -1_000), refund('card-a', -1_000, 1)]), rates),
      { minor: null, questions: ['refund-card-unknown'] });
    assert.deepEqual(orderCardReward(order('o6', [refund('card-a', -1_000)]), rates), { minor: null, questions: ['refund-card-unknown'] });
  });

  it('a charge refunded in full earns exactly nothing, however its refunds were split or wherever the rates are (the lead\'s rule 1)', () => {
    // 5b01e72f: +10,000 on A at 3%, all of it back on B at 1%: never a known 200. Proven back on A: exactly 0.
    const rates = answers({ cardRates: new Map([['card-a', 300], ['card-b', 100]]) });
    assert.deepEqual(orderCardReward(order('o1', [card('card-a', 10_000), refund('card-b', -10_000)]), rates), { minor: null, questions: ['refund-card-unknown'] });
    assert.deepEqual(orderCardReward(order('o2', [card('card-a', 10_000), refund('card-a', -10_000)]), rates), { minor: 0, questions: [] });
    // 5b01e72f: 1,000 at 1.5% refunded as 500 + 500. Each refund rounded alone would come to 15 − 8 − 8 = −1; the charge,
    // net of its refunds, earns 0.
    const split = order('o3', [card('card-a', 1_000), refund('card-a', -500), refund('card-a', -500)]);
    const onePointFive = answers({ cardRates: new Map([['card-a', 150]]) });
    assert.deepEqual(orderCardReward(split, onePointFive), { minor: 0, questions: [] });
    assert.deepEqual(orderRewards([split], onePointFive).get('o3'), { minor: 0, questions: [] });
    // Whatever the rates: with none answered, a charge refunded in full is still a known 0, and so is an order that paid
    // nothing (a coupon, say), whose part can't be a share of anything.
    assert.deepEqual(orderCardReward(order('o4', [card('card-a', 10_000), refund('card-a', -10_000)]), NO_REWARD_ANSWERS), { minor: 0, questions: [] });
    assert.deepEqual(orderCardReward({ ...order('o5', [{ kind: 'no-reward', amountMinor: 1_000, cardId: null }]), share: null }, NO_REWARD_ANSWERS),
      { minor: 0, questions: [] });
  });

  it('refunds proven to take back more than their charge leave the order unknown, said why: never negative, never a silent zero', () => {
    const rates = answers({ cardRates: new Map([['card-a', 100]]) });
    const over = order('o1', [card('card-a', 1_000), refund('card-a', -600), refund('card-a', -600)]);
    assert.deepEqual(orderCardReward(over, rates), { minor: null, questions: ['refund-exceeds-reward'] });
    assert.deepEqual(orderRewards([over], rates).get('o1'), { minor: null, questions: ['refund-exceeds-reward'] });
    assert.deepEqual(estimatedRewards([over, order('o2', [card('card-a', 50_000)])], rates), { minor: null, questions: ['refund-exceeds-reward'] });
    assert.deepEqual(lotRewards([{ key: 'l1', orderKey: 'o1', costMinor: 1_000, units: 1 }], orderRewards([over], rates)).get('l1'),
      { minor: null, questions: ['refund-exceeds-reward'] });
  });

  it('an order\'s share counts each charge\'s part once, rounded once, in exact integers', () => {
    const rates = answers({ cardRates: new Map([['card-a', 200]]) });
    const shared = (key: string, payments: MetalsRewardOrder['payments'], share: MetalsRewardOrder['share'], waits?: MetalsRewardOrder['waits']) =>
      ({ ...order(key, payments), share, ...(waits ? { waits } : {}) });
    // Two thirds of a 300,000 charge at 2%: 4,000. A kept cost above what was paid counts all of it.
    assert.deepEqual(orderCardReward(shared('o1', [card('card-a', 300_000)], { keptMinor: 200_000, paidMinor: 300_000 }), rates), { minor: 4_000, questions: [] });
    assert.deepEqual(orderCardReward(shared('o2', [card('card-a', 300_000)], { keptMinor: 400_000, paidMinor: 300_000 }), rates), { minor: 6_000, questions: [] });
    // Half of 99 cents at 1% is 0.495 cents: 0, never the 1 of 49.5 rounded to 50 first.
    const onePercent = answers({ cardRates: new Map([['card-a', 100]]) });
    assert.deepEqual(orderCardReward(shared('o3', [card('card-a', 99)], { keptMinor: 1, paidMinor: 2 }), onePercent), { minor: 0, questions: [] });
    // A part that can't be told: the order waits, saying why (its cost, or else how it was paid).
    assert.deepEqual(orderCardReward(shared('o4', [card('card-a', 300_000)], null, ['cost-incomplete']), rates), { minor: null, questions: ['cost-incomplete'] });
    assert.deepEqual(orderCardReward(shared('o5', [card('card-a', 300_000)], null), rates), { minor: null, questions: ['payment-not-stated'] });
    // A share that isn't a part of what was paid is a caller's error.
    assert.throws(() => orderCardReward(shared('o6', [card('card-a', 1)], { keptMinor: 1, paidMinor: 0 }), rates), RangeError);
    assert.throws(() => orderCardReward(shared('o7', [card('card-a', 1)], { keptMinor: -1, paidMinor: 1 }), rates), RangeError);
  });

  it('each tender maps to how it earns: a refund as a card, PayPal and debit are questions, cash and gift cards earn nothing', () => {
    assert.equal(rewardPaymentKind('card'), 'card');
    assert.equal(rewardPaymentKind('card-refund'), 'card');
    assert.equal(rewardPaymentKind('shop-card'), 'shop-card');
    for (const tender of ['paypal', 'debit', 'not-stated']) assert.equal(rewardPaymentKind(tender), 'not-stated', tender);
    for (const tender of ['cash', 'gift-card', 'store-balance', 'reward-certificate', 'coupon']) {
      assert.equal(rewardPaymentKind(tender), 'no-reward', tender);
    }
    // A tender this module doesn't know is a question, never assumed to earn nothing (fail closed; G1d, PR-R).
    for (const tender of ['other', 'check', 'buy-now-pay-later', '', 'Cash']) assert.equal(rewardPaymentKind(tender), 'not-stated', tender);
  });
});

describe('metals rewards: the Costco Executive reward, per membership year', () => {
  const membership = { basisPoints: 200, metalsEligible: true, capMinor: 125_000 };
  const costco = (key: string, eligibleMinor: number | null, year: string | null = '2026') =>
    order(key, [{ kind: 'no-reward', amountMinor: eligibleMinor, cardId: null }], { membershipId: 'mem-1', year, eligibleMinor });

  it('under the cap: the metals earn the rate on their share of the year, split exactly between their orders', () => {
    // A year of 1,000,000 cents of eligible spending, 300,000 of it metals: the year's reward 20,000; the metals' 6,000.
    const rates = answers({ memberships: new Map([['mem-1', membership]]), membershipYearSpendMinor: new Map([[membershipYearKey('mem-1', '2026'), 1_000_000]]) });
    const shares = costcoRewardShares([costco('c1', 100_000), costco('c2', 200_000)], rates);
    assert.deepEqual(shares.get('c1'), { minor: 2_000, questions: [] });
    assert.deepEqual(shares.get('c2'), { minor: 4_000, questions: [] });
  });

  it('over the cap: the year pays the cap once, and the metals take their proportional share of it', () => {
    // 10,000,000 cents of eligible spending would earn 200,000; the cap pays 125,000; metals are 20% of the year: 25,000.
    const rates = answers({ memberships: new Map([['mem-1', membership]]), membershipYearSpendMinor: new Map([[membershipYearKey('mem-1', '2026'), 10_000_000]]) });
    const shares = costcoRewardShares([costco('c1', 1_000_000), costco('c2', 1_000_000)], rates);
    assert.deepEqual(shares.get('c1'), { minor: 12_500, questions: [] });
    assert.deepEqual(shares.get('c2'), { minor: 12_500, questions: [] });
  });

  it('an order\'s share doesn\'t change with the period shown: it is its part of the year, not of the orders listed', () => {
    const rates = answers({ memberships: new Map([['mem-1', membership]]), membershipYearSpendMinor: new Map([[membershipYearKey('mem-1', '2026'), 10_000_000]]) });
    const all = costcoRewardShares([costco('c1', 1_000_000), costco('c2', 1_000_000)], rates);
    const one = costcoRewardShares([costco('c1', 1_000_000)], rates, [costco('c1', 1_000_000), costco('c2', 1_000_000)]);
    assert.deepEqual(one.get('c1'), all.get('c1'));
  });

  it('at a rounding boundary too: each share is fixed by the whole year, split exactly, ties to the lower order key', () => {
    // A year of 10,000,000 (capped reward 125,000) with two metal orders of 100,020: the metals' share 2,501 splits
    // 1,251 + 1,250. A period listing c1 alone still takes 1,251: its part of the year, not of the orders listed.
    const rates = answers({ memberships: new Map([['mem-1', membership]]), membershipYearSpendMinor: new Map([[membershipYearKey('mem-1', '2026'), 10_000_000]]) });
    const year = [costco('c1', 100_020), costco('c2', 100_020)];
    const all = costcoRewardShares(year, rates);
    assert.deepEqual([all.get('c1'), all.get('c2')], [{ minor: 1_251, questions: [] }, { minor: 1_250, questions: [] }]);
    const period = costcoRewardShares([costco('c1', 100_020)], rates, year);
    assert.deepEqual(period.get('c1'), { minor: 1_251, questions: [] });
    assert.equal(period.has('c2'), false);
    // Whatever order the year's orders come in.
    assert.deepEqual(costcoRewardShares([...year].reverse(), rates).get('c1'), { minor: 1_251, questions: [] });
    // One of the year's orders with its spending unknown leaves every share of that year unknown.
    assert.deepEqual(costcoRewardShares([costco('c1', 100_020)], rates, [costco('c1', 100_020), costco('c2', null)]).get('c1'),
      { minor: null, questions: ['membership-spending-unknown'] });
  });

  it('each missing answer is its own question; metals not eligible earn a known zero', () => {
    const noYearSpend = answers({ memberships: new Map([['mem-1', membership]]) });
    assert.deepEqual(costcoRewardShares([costco('c1', 100_000)], NO_REWARD_ANSWERS).get('c1'), { minor: null, questions: ['membership-rate-needed'] });
    assert.deepEqual(costcoRewardShares([costco('c1', 100_000, null)], noYearSpend).get('c1'), { minor: null, questions: ['membership-year-unknown'] });
    assert.deepEqual(costcoRewardShares([costco('c1', null)], noYearSpend).get('c1'), { minor: null, questions: ['membership-spending-unknown'] });
    assert.deepEqual(costcoRewardShares([costco('c1', 100_000)], noYearSpend).get('c1'), { minor: null, questions: ['membership-spending-unknown'] });
    const tooSmall = answers({ memberships: new Map([['mem-1', membership]]), membershipYearSpendMinor: new Map([[membershipYearKey('mem-1', '2026'), 50_000]]) });
    assert.deepEqual(costcoRewardShares([costco('c1', 100_000)], tooSmall).get('c1'), { minor: null, questions: ['membership-spending-unknown'] });
    const notEligible = answers({ memberships: new Map([['mem-1', { ...membership, metalsEligible: false }]]) });
    assert.deepEqual(costcoRewardShares([costco('c1', 100_000)], notEligible).get('c1'), { minor: 0, questions: [] });
    // A year whose spending is a known zero (refunded in full, say): a known zero, not a question.
    const nothingSpent = answers({ memberships: new Map([['mem-1', membership]]), membershipYearSpendMinor: new Map([[membershipYearKey('mem-1', '2026'), 0]]) });
    assert.deepEqual(costcoRewardShares([costco('c1', 0)], nothingSpent).get('c1'), { minor: 0, questions: [] });
    // An order with nothing eligible spent takes no part of any year's reward, whatever the answers: none are asked.
    assert.deepEqual(costcoRewardShares([costco('c1', 0, null)], NO_REWARD_ANSWERS).get('c1'), { minor: 0, questions: [] });
  });
});

describe('metals rewards: estimated rewards and a matched return', () => {
  const rates = answers({ cardRates: new Map([['card-a', 200]]) });
  const lots: MetalsRewardLot[] = [
    { key: 'lot-1', orderKey: 'o1', costMinor: 300_000, units: 3 },
    { key: 'lot-2', orderKey: 'o1', costMinor: 100_000, units: 1 },
  ];

  it('estimated rewards are their own line: card rewards and Costco shares, known only when every part is', () => {
    const orders = [order('o1', [card('card-a', 400_000)]), order('o2', [card('card-a', 100_000)])];
    assert.deepEqual(estimatedRewards(orders, rates), { minor: 8_000 + 2_000, questions: [] });
    assert.deepEqual(estimatedRewards([...orders, order('o3', [card('card-z', 1)])], rates), { minor: null, questions: ['card-rate-needed'] });
    assert.deepEqual(sumRewardFigures([]), { minor: 0, questions: [] });
  });

  it('an order\'s rewards are shared by its lots in proportion to their cost, exactly', () => {
    const shares = lotRewards(lots, orderRewards([order('o1', [card('card-a', 400_000)])], rates));
    assert.deepEqual(shares.get('lot-1'), { minor: 6_000, questions: [] });
    assert.deepEqual(shares.get('lot-2'), { minor: 2_000, questions: [] });
    const unknown = lotRewards(lots, orderRewards([order('o1', [card(null, 400_000)])], rates));
    assert.deepEqual(unknown.get('lot-1'), { minor: null, questions: ['card-unknown'] });
  });

  it('a sale\'s profit gains the rewards of the very units it sold, and holdings those of the units still held', () => {
    const shares = lotRewards(lots, orderRewards([order('o1', [card('card-a', 400_000)])], rates));
    const byKey = new Map(lots.map((lot) => [lot.key, lot]));
    // Two of lot-1's three units sold (earliest units first): 2/3 of its 6,000.
    assert.deepEqual(withMatchedRewards(-5_000, [{ lotKey: 'lot-1', fromUnit: 0, units: 2 }], byKey, shares), { minor: -5_000 + 4_000, questions: [] });
    // Still held: lot-1's last unit and lot-2's one.
    assert.deepEqual(withMatchedRewards(12_000, [{ lotKey: 'lot-1', fromUnit: 2, units: 1 }, { lotKey: 'lot-2', fromUnit: 0, units: 1 }], byKey, shares),
      { minor: 12_000 + 2_000 + 2_000, questions: [] });
  });

  it('a lot\'s reward cents belong to its units, earliest first: its uses always add up to its whole reward', () => {
    // A lot of 2 units whose reward is 101 cents: its earlier unit owns 51 and its later 50, never 51 and 51.
    const lot: MetalsRewardLot = { key: 'lot-x', orderKey: 'ox', costMinor: 1_000, units: 2 };
    const byKey = new Map([[lot.key, lot]]);
    const reward = new Map([[lot.key, { minor: 101, questions: [] }]]);
    assert.deepEqual(withMatchedRewards(0, [{ lotKey: 'lot-x', fromUnit: 0, units: 1 }], byKey, reward), { minor: 51, questions: [] });
    assert.deepEqual(withMatchedRewards(0, [{ lotKey: 'lot-x', fromUnit: 1, units: 1 }], byKey, reward), { minor: 50, questions: [] });
    // One cycle of both units, or two cycles of one each: the same 101.
    assert.deepEqual(withMatchedRewards(0, [{ lotKey: 'lot-x', fromUnit: 0, units: 2 }], byKey, reward), { minor: 101, questions: [] });
    assert.deepEqual(withMatchedRewards(0, [{ lotKey: 'lot-x', fromUnit: 0, units: 1 }, { lotKey: 'lot-x', fromUnit: 1, units: 1 }], byKey, reward),
      { minor: 101, questions: [] });
    // Units outside the lot are a caller's error, never a guessed figure: whatever the reward, even for no units.
    assert.throws(() => withMatchedRewards(0, [{ lotKey: 'lot-x', fromUnit: 1, units: 2 }], byKey, reward), RangeError);
    assert.throws(() => withMatchedRewards(0, [{ lotKey: 'lot-x', fromUnit: 3, units: 0 }], byKey, reward), RangeError);
    assert.throws(() => withMatchedRewards(0, [{ lotKey: 'lot-x', fromUnit: 2, units: 1 }], byKey,
      new Map([[lot.key, { minor: null, questions: ['card-rate-needed' as const] }]])), RangeError);
  });

  it('an unknown base or reward leaves the return including rewards unknown, with what it waits for', () => {
    const byKey = new Map(lots.map((lot) => [lot.key, lot]));
    const known = lotRewards(lots, orderRewards([order('o1', [card('card-a', 400_000)])], rates));
    assert.deepEqual(withMatchedRewards(null, [{ lotKey: 'lot-1', fromUnit: 0, units: 1 }], byKey, known), { minor: null, questions: [] });
    const unknown = lotRewards(lots, orderRewards([order('o1', [card('card-a', 400_000)])], NO_REWARD_ANSWERS));
    assert.deepEqual(withMatchedRewards(1_000, [{ lotKey: 'lot-1', fromUnit: 0, units: 1 }], byKey, unknown), { minor: null, questions: ['card-rate-needed'] });
  });

  it('a sum with one unknown part is unknown, whether or not that part says why', () => {
    assert.deepEqual(sumRewardFigures([{ minor: null, questions: [] }, { minor: 200, questions: [] }]), { minor: null, questions: [] });
    // A return with an unknown base, its rewards known, added to a known figure: still unknown.
    const byKey = new Map(lots.map((lot) => [lot.key, lot]));
    const known = lotRewards(lots, orderRewards([order('o1', [card('card-a', 400_000)])], rates));
    const unknownBase = withMatchedRewards(null, [{ lotKey: 'lot-1', fromUnit: 0, units: 1 }], byKey, known);
    assert.deepEqual(sumRewardFigures([unknownBase, { minor: 200, questions: [] }]), { minor: null, questions: [] });
  });

  it('a lot\'s kept units are its first ones, at their cost by the ledger\'s unit split (largest remainder, earlier units first)', () => {
    assert.equal(keptUnitsCost(1_000, 2, 1), 500);
    assert.equal(keptUnitsCost(1_001, 2, 1), 501);
    assert.equal(keptUnitsCost(1_001, 2, 2), 1_001);
    assert.equal(keptUnitsCost(1_001, 2, 0), 0);
    assert.throws(() => keptUnitsCost(1_000, 2, 3), RangeError);
    assert.throws(() => keptUnitsCost(1_000, 0, 0), RangeError);
  });

  it('with no answers stored (production today), every figure waits for its questions: never a number', () => {
    const orders = [
      order('o1', [card('card-a', 400_000)]),
      order('o2', [{ kind: 'shop-card', amountMinor: 10_000, cardId: null }]),
      order('o3', [card('card-b', 5_000)], { membershipId: 'mem-1', year: null, eligibleMinor: 5_000 }),
    ];
    const total = estimatedRewards(orders, NO_REWARD_ANSWERS);
    assert.equal(total.minor, null);
    assert.deepEqual(total.questions, ['card-rate-needed', 'shop-card-buyer-unknown', 'membership-rate-needed']);
  });
});
