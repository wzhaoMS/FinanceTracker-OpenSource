import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_CATEGORY_HOLD_REASONS,
  isCardCategoryHoldReason,
  resolveCardCategorySplits,
  type CardCategoryResolution,
  type CardCategoryResolverSnapshot,
  type CardCategorySplitRow,
} from './cardCategoryParts.js';

// Synthetic rows only: made-up ids and amounts.
const row = (id: string): CardCategorySplitRow =>
  ({ id, status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 10000, issuerCategory: 'Merchandise', userCategory: null });
const snapshot = (answers: Array<[string, CardCategoryResolution]>): CardCategoryResolverSnapshot =>
  ({ version: 'rev-hold', resolve: () => new Map(answers) });

test('the whole-row hold reasons are one closed list, with a receipt\'s precious metals last', () => {
  assert.deepEqual(CARD_CATEGORY_HOLD_REASONS, ['match-held', 'mixed-tender-unproven', 'item-identity-unproven', 'negative-component',
    'currency-mismatch', 'inconsistent-evidence', 'refund-unattributed', 'asset-purchase', 'asset-uncertain']);
  assert.deepEqual(CARD_CATEGORY_HOLD_REASONS.filter((reason) => !isCardCategoryHoldReason(reason)), []);
  assert.equal(isCardCategoryHoldReason('asset-purchases'), false);
});

test('a receipt\'s precious metals keep a row whole, each counted under its own reason', () => {
  const result = resolveCardCategorySplits([row('metal'), row('maybe-metal')], {
    requested: 'enriched',
    snapshot: snapshot([
      ['metal', { kind: 'whole-row', cardTransactionId: 'metal', reason: 'asset-purchase' }],
      ['maybe-metal', { kind: 'whole-row', cardTransactionId: 'maybe-metal', reason: 'asset-uncertain' }],
    ]),
    knownCategories: new Set(['Merchandise']),
    isAllowedCategoryName: () => true,
  });
  assert.deepEqual(result.outcomes.get('metal'), { kind: 'held', reason: 'asset-purchase' });
  assert.deepEqual(result.outcomes.get('maybe-metal'), { kind: 'held', reason: 'asset-uncertain' });
  assert.deepEqual(result.marker.heldOrDeclined, [{ reason: 'asset-purchase', count: 1 }, { reason: 'asset-uncertain', count: 1 }]);
  assert.equal(result.parts.size, 0);
});
