import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardSpendingAccounting } from '@finance-tracker/shared';

import {
  assetPurchasesText,
  defaultRuleMinimum,
  exclusionSourceText,
  notMetalsCategory,
  pendingEffectText,
  pendingNoteText,
  queueEffectText,
  reconciliationParts,
  rulePreviewText,
  ruleText,
  sameRuleInput,
  suggestionReason,
  whatCountsStatement,
  type WhatCountsStatement,
} from './whatCounts';

// Synthetic figures only.
const amounts = (netMinor: number, chargesMinor = Math.max(netMinor, 0), creditsMinor = Math.min(netMinor, 0), count = 1) =>
  ({ netMinor, chargesMinor, creditsMinor, count });

function entry(patch: Partial<CardSpendingAccounting> = {}): CardSpendingAccounting {
  return {
    currency: 'USD',
    activity: amounts(1_000_000 - 500_000 + 20_000 + 412_399, 1_432_399, -500_000, 9),
    spending: amounts(1_000_000, 1_000_000, 0, 5),
    notSpending: { ...amounts(432_399, 432_399, 0, 2), assetPurchases: amounts(412_399), other: amounts(20_000) },
    transfers: amounts(-500_000, 0, -500_000, 2),
    pending: { count: 0, netMinor: 0 },
    possibleAssetPurchases: amounts(0, 0, 0, 0),
    ...patch,
  };
}

test('the spending total says what is waiting, and spending without it', () => {
  assert.equal(pendingEffectText(entry()), null);
  assert.equal(pendingEffectText(null), null);
  assert.equal(
    pendingEffectText(entry({ possibleAssetPurchases: amounts(250_099) })),
    '$2,500.99 possibly precious metals awaiting your confirmation · $7,499.01 without them',
  );
  // Only a refund waiting: confirming it adds to spending, and the sentence says it is refunds.
  assert.equal(
    pendingEffectText(entry({ possibleAssetPurchases: amounts(-40_500, 0, -40_500, 1) })),
    '$405.00 of refunds possibly for precious metals awaiting your confirmation · $10,405.00 without them',
  );
  assert.equal(assetPurchasesText(entry()), '$4,123.99 precious metals bought · not counted');
  assert.equal(assetPurchasesText(entry({ notSpending: { ...amounts(20_000), assetPurchases: amounts(0, 0, 0, 0), other: amounts(20_000) } })), null);
});

test('the parts add up to the activity, and empty parts are left out', () => {
  const { activityMinor, parts } = reconciliationParts(entry());
  assert.equal(parts.reduce((sum, part) => sum + part.amountMinor, 0), activityMinor);
  assert.deepEqual(parts.map((part) => part.key), ['spending', 'asset', 'other', 'transfers']);
  const plain = reconciliationParts(entry({
    activity: amounts(1_000_000), notSpending: { ...amounts(0, 0, 0, 0), assetPurchases: amounts(0, 0, 0, 0), other: amounts(0, 0, 0, 0) },
    transfers: amounts(0, 0, 0, 0),
  }));
  assert.deepEqual(plain.parts.map((part) => part.key), ['spending']);
});

type Amounts = ReturnType<typeof amounts>;
const nothing = (): Amounts => amounts(0, 0, 0, 0);
const sumOf = (...list: Amounts[]): Amounts => list.reduce((sum, item) => ({
  netMinor: sum.netMinor + item.netMinor, chargesMinor: sum.chargesMinor + item.chargesMinor,
  creditsMinor: sum.creditsMinor + item.creditsMinor, count: sum.count + item.count,
}), nothing());
/** An accounting whose activity is its parts', as the API's is. */
function fromParts(parts: { spending?: Amounts; asset?: Amounts; other?: Amounts; transfers?: Amounts }): CardSpendingAccounting {
  const { spending = nothing(), asset = nothing(), other = nothing(), transfers = nothing() } = parts;
  return {
    currency: 'USD', activity: sumOf(spending, asset, other, transfers), spending,
    notSpending: { ...sumOf(asset, other), assetPurchases: asset, other }, transfers,
    pending: { count: 0, netMinor: 0 }, possibleAssetPurchases: nothing(),
  };
}
const lines = (statement: WhatCountsStatement) => [...statement.counted, ...statement.notCounted];
const lineTotal = (statement: WhatCountsStatement) => lines(statement).reduce((sum, row) => sum + row.amountMinor, 0);
const said = (statement: WhatCountsStatement) => lines(statement).map((row) => [row.key, row.label, row.amountMinor]);

test('the statement: counted and not, each line a label and its signed amount, adding up to the activity to the cent', () => {
  const plain = whatCountsStatement(entry());
  assert.deepEqual(said(plain), [
    ['spending-charges', 'Charges', 1_000_000],
    ['asset-charges', 'Precious metals bought', 412_399],
    ['other', 'Other (cash advances and the like)', 20_000],
    ['transfers', 'Card payments', -500_000],
  ]);
  assert.deepEqual(plain.counted.map((row) => row.key), ['spending-charges']);
  assert.equal(plain.activityMinor, 932_399);
  assert.equal(lineTotal(plain), plain.activityMinor);

  // Refunds outweigh charges: spending is negative, and its charges and its refunds and credits are lines of their own.
  const refunded = fromParts({ spending: amounts(-16_850, 3_150, -20_000, 3), transfers: amounts(-50_000, 0, -50_000, 1) });
  const net = whatCountsStatement(refunded);
  assert.deepEqual(said(net), [
    ['spending-charges', 'Charges', 3_150],
    ['spending-credits', 'Refunds and credits', -20_000],
    ['transfers', 'Card payments', -50_000],
  ]);
  assert.equal(net.activityMinor, -66_850);
  assert.equal(lineTotal(net), refunded.activity.netMinor);

  // Precious metals with only a refund in view: a negative part, said as what it is.
  const back = fromParts({ spending: amounts(8_450), asset: amounts(-98_000, 0, -98_000, 1), other: amounts(20_000) });
  assert.deepEqual(said(whatCountsStatement(back)), [
    ['spending-charges', 'Charges', 8_450],
    ['asset-credits', 'Precious metals refunds and credits', -98_000],
    ['other', 'Other (cash advances and the like)', 20_000],
  ]);
  assert.equal(lineTotal(whatCountsStatement(back)), -69_550);
  // Both ways: bought and refunded apart, never one net figure of the two.
  const both = fromParts({ spending: amounts(8_450), asset: amounts(27_000, 125_000, -98_000, 2) });
  assert.deepEqual(said(whatCountsStatement(both)).slice(1), [
    ['asset-charges', 'Precious metals bought', 125_000],
    ['asset-credits', 'Precious metals refunds and credits', -98_000],
  ]);
  assert.equal(lineTotal(whatCountsStatement(both)), both.activity.netMinor);

  // Card payments and other are one line each, at their net, whatever their sides.
  const returned = fromParts({ spending: amounts(8_450), transfers: amounts(-95_000, 5_000, -100_000, 2), other: amounts(-1_500, 500, -2_000, 2) });
  assert.deepEqual(said(whatCountsStatement(returned)).slice(1), [
    ['other', 'Other (cash advances and the like)', -1_500],
    ['transfers', 'Card payments', -95_000],
  ]);

  // Rows of nothing are still said (at $0.00); parts without rows are not.
  const zero = whatCountsStatement(fromParts({ spending: amounts(0, 0, 0, 1), other: amounts(0, 0, 0, 2) }));
  assert.deepEqual(said(zero), [['spending-charges', 'Charges', 0], ['other', 'Other (cash advances and the like)', 0]]);
  assert.deepEqual(whatCountsStatement(fromParts({})), { counted: [], notCounted: [], activityMinor: 0 });

  // An answer whose sides do not add up to its part's net: one line at the net, so the lines still add up.
  const odd = fromParts({ spending: { netMinor: 5_000, chargesMinor: 9_000, creditsMinor: -1_000, count: 2 }, transfers: amounts(-2_000, 0, -2_000, 1) });
  assert.deepEqual(said(whatCountsStatement(odd)), [['spending-charges', 'Charges', 5_000], ['transfers', 'Card payments', -2_000]]);
  assert.equal(lineTotal(whatCountsStatement(odd)), odd.activity.netMinor);
  const oddBack = fromParts({ asset: { netMinor: -3_000, chargesMinor: 0, creditsMinor: -1_000, count: 1 } });
  assert.deepEqual(said(whatCountsStatement(oddBack)), [['asset-credits', 'Precious metals refunds and credits', -3_000]]);

  // No sum to work out: no line is an equation.
  for (const statement of [plain, net, whatCountsStatement(back), whatCountsStatement(both), whatCountsStatement(returned)]) {
    for (const row of lines(statement)) assert.doesNotMatch(row.label, /[=+]/);
  }
});

test('to confirm says what waiting means, and what confirming every one would do to spending', () => {
  const lead = 'Possibly precious metals, counted as spending until you decide.';
  assert.equal(queueEffectText(entry({ possibleAssetPurchases: amounts(662_498, 662_498, 0, 2) }), 2),
    `${lead} Confirming both takes $6,624.98 out of spending.`);
  assert.equal(queueEffectText(entry({ possibleAssetPurchases: amounts(412_399) }), 1), `${lead} Confirming it takes $4,123.99 out of spending.`);
  assert.equal(queueEffectText(entry({ possibleAssetPurchases: amounts(761_263, 761_263, 0, 3) }), 3),
    `${lead} Confirming all 3 takes $7,612.63 out of spending.`);
  // Only a refund waiting: confirming it adds to spending.
  assert.equal(queueEffectText(entry({ possibleAssetPurchases: amounts(-40_500, 0, -40_500, 1) }), 1), `${lead} Confirming it adds $405.00 to spending.`);
  // Nothing it would change, or nothing known: no amount.
  assert.equal(queueEffectText(entry({ possibleAssetPurchases: amounts(0, 40_500, -40_500, 2) }), 1), lead);
  assert.equal(queueEffectText(entry(), 1), lead);
  assert.equal(queueEffectText(null, 2), lead);
});

test('pending rows are said apart: in none of the statement\'s figures until they post', () => {
  assert.equal(pendingNoteText(entry()), null);
  assert.equal(pendingNoteText(entry({ pending: { count: 1, netMinor: 999 } })), '1 pending transaction is not in these figures until it posts.');
  assert.equal(pendingNoteText(entry({ pending: { count: 3, netMinor: -2_100 } })), '3 pending transactions are not in these figures until they post.');
});

test('a suggestion says only what the descriptor and the amount say', () => {
  assert.equal(suggestionReason({ kind: 'purchase', merchantClass: 'costco-online', signals: ['online-warehouse-club', 'at-or-over-floor'], currency: 'USD', purchaseIds: [] }),
    'A large Costco.com order (Costco.com sells bullion online)');
  assert.equal(suggestionReason({ kind: 'purchase', merchantClass: 'bullion-dealer', signals: ['bullion-dealer', 'at-or-over-floor', 'gift-card-like'], currency: 'USD', purchaseIds: [] }),
    'A bullion dealer; a round amount, like gift cards');
  assert.match(suggestionReason({ kind: 'purchase', merchantClass: 'costco-warehouse', signals: ['warehouse-descriptor', 'at-or-over-floor'], currency: 'USD', purchaseIds: [] }),
    /^A large Costco warehouse charge/);
  assert.equal(suggestionReason({ kind: 'refund', merchantClass: 'costco-online', signals: ['refund-of-excluded', 'partial-refund'], currency: 'USD', purchaseIds: ['a'] }),
    'A partial refund from the same seller within 90 days of a precious-metals purchase you confirmed');
  assert.equal(suggestionReason({ kind: 'refund', merchantClass: 'costco-online', signals: ['refund-of-suggested', 'ambiguous-refund'], currency: 'USD', purchaseIds: ['a', 'b'] }),
    'More than one purchase from this seller could be the one refunded, among them a suggested purchase');
  assert.equal(suggestionReason({ kind: 'refund', merchantClass: 'costco-online', signals: ['refund-of-excluded', 'after-earlier-refund'], currency: 'USD', purchaseIds: ['a'] }),
    'A refund after an earlier refund of a precious-metals purchase you confirmed, so what is left of it is not certain');
  // The channel: a full refund whose description shows another channel, or none, is asked; a partial one says partial.
  assert.equal(suggestionReason({ kind: 'refund', merchantClass: 'sams-club', signals: ['refund-of-excluded', 'channel-unconfirmed'], currency: 'USD', purchaseIds: ['a'] }),
    'A refund from the same seller within 90 days of a precious-metals purchase you confirmed, but its description doesn\'t show the same channel (online or in store)');
  assert.equal(suggestionReason({ kind: 'refund', merchantClass: 'bullion-dealer', signals: ['refund-of-suggested', 'partial-refund', 'channel-unconfirmed'], currency: 'USD', purchaseIds: ['a'] }),
    'A partial refund from the same seller within 90 days of a suggested purchase');
  for (const text of [
    suggestionReason({ kind: 'purchase', merchantClass: 'walmart-online', signals: [], currency: 'USD', purchaseIds: [] }),
  ]) assert.doesNotMatch(text, /\b(will|always|definitely)\b/i);
});

test('rules and sources read as sentences', () => {
  const rule = { id: `csr_${'a'.repeat(32)}`, merchantClass: 'walmart-online' as const, currency: 'USD', minAmountMinor: 100_000 };
  assert.equal(ruleText(rule), 'Walmart.com charges of $1,000.00 or more are precious metals');
  assert.equal(exclusionSourceText({ reason: 'asset-purchase', source: 'owner-category' }), 'your category');
  assert.equal(exclusionSourceText({ reason: 'asset-purchase', source: 'paired-refund', purchaseId: 'x' }), 'refund of a precious-metals purchase');
  assert.equal(exclusionSourceText({ reason: 'asset-purchase', source: 'owner-rule', ruleId: rule.id },
    [{ ...rule, reason: 'asset-purchase', category: 'Precious metals', createdAt: '2026-10-16T12:00:00.000Z', revokedAt: null }]),
  'your rule: Walmart.com charges of $1,000.00 or more are precious metals');
  assert.equal(
    rulePreviewText({ purchases: 2, refunds: 1, amounts: amounts(810_001, 1_222_400, -412_399, 3), firstDate: '2025-03-02', lastDate: '2026-04-02', ownerDecided: 1, alreadyExcluded: 0 }, 'USD'),
    'Takes $8,100.01 out of spending: 2 charges and 1 exact refund, Mar 2, 2025 – Apr 2, 2026. It leaves 1 you kept as spending.',
  );
  assert.equal(rulePreviewText({ purchases: 0, refunds: 0, amounts: amounts(0, 0, 0, 0), firstDate: null, lastDate: null, ownerDecided: 0, alreadyExcluded: 0 }, 'USD'),
    'It covers no charge yet; it applies to new ones as they come in.');
});

test('not metals keeps the shown category, and asks when there is none', () => {
  assert.equal(notMetalsCategory('Merchandise & Supplies-Wholesale Stores'), 'Merchandise & Supplies-Wholesale Stores');
  assert.equal(notMetalsCategory('Uncategorized'), null);
  assert.equal(notMetalsCategory(''), null);
});

test('a rule starts at the smallest suggested charge of its class, in whole hundreds', () => {
  const items = [
    { kind: 'purchase' as const, merchantClass: 'costco-online' as const, amountMinor: 412_399, currency: 'USD' },
    { kind: 'purchase' as const, merchantClass: 'costco-online' as const, amountMinor: 250_099, currency: 'USD' },
    { kind: 'refund' as const, merchantClass: 'costco-online' as const, amountMinor: -50_000, currency: 'USD' },
  ];
  assert.equal(defaultRuleMinimum(items, 'costco-online', 'USD'), 250_000);
  assert.equal(defaultRuleMinimum(items, 'walmart-online', 'USD'), 100_000);
});

test('a preview speaks only for the exact rule it was asked for', () => {
  const asked = { merchantClass: 'costco-online' as const, currency: 'USD', minAmountMinor: 600_000 };
  assert.equal(sameRuleInput(asked, { ...asked }), true);
  for (const other of [{ ...asked, minAmountMinor: 100_000 }, { ...asked, minAmountMinor: 600_001 }, { ...asked, currency: 'EUR' },
    { ...asked, merchantClass: 'walmart-online' as const }]) {
    assert.equal(sameRuleInput(asked, other), false, JSON.stringify(other));
  }
});
