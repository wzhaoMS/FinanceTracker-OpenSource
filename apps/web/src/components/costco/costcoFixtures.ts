import { ITEM_TAXONOMY_V2_VIEW, type ItemTaxonomyV2NodeId } from '@finance-tracker/shared';
import type {
  RetailApiLine,
  RetailApiLineCategory,
  RetailApiReceiptDetail,
  RetailApiReceiptPresent,
  RetailApiReceiptRow,
  RetailApiReceiptsPresent,
  RetailApiSummaryPresent,
} from '@finance-tracker/shared/retail-api';

/**
 * Synthetic Costco receipts read API bodies for the page's tests: made-up refs, labels, titles, amounts and last
 * fours only. Typed against the contract (the summary and the list at version 1, the receipt detail at version 2), so
 * each is a body the API may send.
 */

const LETTERS = 'abcdefghijklmnop';
/** 32 letters of letter hex for `n`, as the API's opaque refs are written. */
const letters = (n: number) => n.toString(16).padStart(32, '0').replace(/[0-9a-f]/g, (digit) => LETTERS[parseInt(digit, 16)]);

export const membershipRef = (n: number) => `rtl-mbr-${letters(n)}`;
export const receiptRef = (n: number) => `rcp-${letters(n)}`;
export const lineRef = (n: number) => `rli-${letters(n)}`;
export const shipmentRef = (n: number) => `shp-${letters(n)}`;

export const MEMBERSHIP_A = membershipRef(1);
export const MEMBERSHIP_B = membershipRef(2);

export function summaryFixture(): RetailApiSummaryPresent {
  return {
    format: 'holdr.retail-costco-summary',
    version: 1,
    state: 'present',
    memberships: [
      {
        membershipRef: MEMBERSHIP_A,
        label: 'Sample Household',
        owner: 'alex',
        receipts: { warehouse: { active: 1, quarantined: 1 }, gas: { active: 0, quarantined: 0 }, online: { active: 1, quarantined: 0 } },
        capture: {
          ranges: [
            { channel: 'online', from: '2026-01-01', to: '2026-10-31' },
            { channel: 'warehouse', from: '2026-01-01', to: '2026-11-02' },
          ],
          capturedThrough: '2026-11-03',
        },
      },
      {
        membershipRef: MEMBERSHIP_B,
        label: 'Sample Executive',
        owner: 'casey',
        receipts: { warehouse: { active: 0, quarantined: 1 }, gas: { active: 1, quarantined: 0 }, online: { active: 0, quarantined: 0 } },
        capture: { ranges: [{ channel: 'warehouse', from: '2026-09-01', to: '2026-10-31' }], capturedThrough: '2026-11-01' },
      },
    ],
    receipts: { warehouse: { active: 1, quarantined: 1 }, gas: { active: 1, quarantined: 0 }, online: { active: 1, quarantined: 0 } },
    quarantine: { 'duplicate-across-memberships': 0, 'receipt-changed': 1, 'policy-reread-changed': 0, 'receipt-held-later': 0 },
    held: 2,
  };
}

/** A warehouse sale, an online order paid partly by Shop Card, a quarantined refund and a gas receipt. */
export function rowsFixture(): RetailApiReceiptRow[] {
  return [
    {
      receiptRef: receiptRef(1), channel: 'warehouse', sign: 'sale', status: null, date: '2026-11-02', currency: 'USD', totalMinor: 1000,
      itemLines: 4, memberships: [MEMBERSHIP_A], state: 'active', quarantineReason: null,
      tenders: { kinds: ['card'], cardSpendingMinor: 1000, otherMinor: 0 }, matchingLines: null,
    },
    {
      receiptRef: receiptRef(2), channel: 'online', sign: 'sale', status: 'delivered', date: '2026-10-20', currency: 'USD', totalMinor: 1500,
      itemLines: 1, memberships: [MEMBERSHIP_A], state: 'active', quarantineReason: null,
      tenders: { kinds: ['card', 'shop-card'], cardSpendingMinor: 1500, otherMinor: 500 }, matchingLines: null,
    },
    {
      receiptRef: receiptRef(3), channel: 'warehouse', sign: 'refund', status: null, date: '2026-10-05', currency: 'USD', totalMinor: -1234,
      itemLines: 1, memberships: [MEMBERSHIP_A, MEMBERSHIP_B], state: 'quarantined', quarantineReason: 'receipt-changed',
      tenders: { kinds: ['card-refund'], cardSpendingMinor: -1234, otherMinor: 0 }, matchingLines: null,
    },
    {
      receiptRef: receiptRef(4), channel: 'gas', sign: 'sale', status: null, date: '2026-09-30', currency: 'USD', totalMinor: 4567,
      itemLines: 0, memberships: [MEMBERSHIP_B], state: 'active', quarantineReason: null,
      tenders: { kinds: ['card'], cardSpendingMinor: 4567, otherMinor: 0 }, matchingLines: null,
    },
  ];
}

export function receiptsFixture(rows: RetailApiReceiptRow[] = rowsFixture()): RetailApiReceiptsPresent {
  return { format: 'holdr.retail-costco-receipts', version: 1, state: 'present', total: rows.length, offset: 0, limit: 50, receipts: rows };
}

/** A line with every fact empty, for the fixtures to fill in; each states its category (null on a coupon). */
function line(n: number, facts: Partial<RetailApiLine> & Pick<RetailApiLine, 'kind' | 'amountMinor' | 'category'>): RetailApiLine {
  return {
    lineRef: lineRef(n), itemNumber: null, title: null, title2: null, quantity: null, unitPriceMinor: null, shippingMinor: null,
    taxFlag: null, storedValue: null, fulfilment: null, fuel: null, couponFor: null, feeOf: null, metal: null, metalUncertain: null,
    events: null, shipments: [], ...facts,
  };
}

/** A line's category: `node` of the shared item tree (v2), with that node's own card category; unresolved unless stated. */
export function categoryFixture(node: ItemTaxonomyV2NodeId, facts: Partial<Omit<RetailApiLineCategory, 'node' | 'cardCategory'>> = {}):
  RetailApiLineCategory {
  return {
    node, cardCategory: ITEM_TAXONOMY_V2_VIEW.node(node)!.cardCategory, source: null, confidenceBp: null, suggested: false, suggestion: null,
    metalHold: false, ...facts,
  };
}

/**
 * Receipt 1, a warehouse sale: an item an agent filed as suggested and its coupon, a silver round (metal facts, filed
 * by the title rule under Precious metals), an item the owner filed and its fee (filed by its department's review), a
 * coupon on the whole receipt, and an untitled item the metal guard flagged, in Needs review with an agent's low
 * suggestion; one tax legend; paid by one card.
 */
export function warehouseLinesFixture(): RetailApiLine[] {
  return [
    line(1, { kind: 'item', itemNumber: '1234567', title: 'SAMPLE WIDGET', quantity: 1, unitPriceMinor: 799, amountMinor: 799, taxFlag: 'Y',
      category: categoryFixture('tools-home-improvement/tools', { source: 'agent', confidenceBp: 7200, suggested: true }) }),
    line(2, { kind: 'coupon', itemNumber: '1234567', amountMinor: -200, couponFor: lineRef(1), category: null }),
    line(3, {
      kind: 'item', itemNumber: '2345678', title: 'SAMPLE SILVER ROUND 1 OZT', quantity: 1, unitPriceMinor: 300, amountMinor: 300, taxFlag: 'N',
      metal: { metal: 'XAG', form: 'round', statedWeight: { value: '1', unit: 'ozt' }, pack: 'single', rule: 'title-rule-v3' },
      category: categoryFixture('precious-metals', { source: 'title-rule', metalHold: true }),
    }),
    line(4, { kind: 'item', itemNumber: '3456789', title: 'SAMPLE SPARKLING WATER', title2: 'SAMPLE 12 PACK', quantity: 1, unitPriceMinor: 71,
      amountMinor: 71, taxFlag: 'Y', category: categoryFixture('groceries/beverages', { source: 'owner' }) }),
    line(5, { kind: 'fee', title: 'SAMPLE DEPOSIT', amountMinor: 30, feeOf: lineRef(4),
      category: categoryFixture('groceries/beverages', { source: 'department-review' }) }),
    line(6, { kind: 'coupon', title: 'SAMPLE SAVINGS', amountMinor: -100, category: null }),
    line(7, { kind: 'item', itemNumber: '7654321', quantity: 1, unitPriceMinor: 50, amountMinor: 50,
      metalUncertain: { guard: 'metal-guard-v1', evidence: ['purity'], metal: 'XAU' },
      category: categoryFixture('needs-review', { suggestion: { node: 'groceries/snacks-sweets', confidenceBp: 4500 } }) }),
  ];
}

export function warehouseDetailFixture(): RetailApiReceiptDetail {
  return {
    receiptRef: receiptRef(1), channel: 'warehouse', state: 'active', quarantineReason: null, memberships: [MEMBERSHIP_A],
    date: '2026-11-02', localTime: '14:05', sign: 'sale', status: null, currency: 'USD',
    totals: { subtotalMinor: 950, taxMinor: 50, instantSavingsMinor: 300, discountMinor: null, shippingMinor: null, feesMinor: null,
      storedValueMinor: null, totalMinor: 1000 },
    taxLegends: [{ legend: 'A', amountMinor: 50 }],
    lines: warehouseLinesFixture(),
    tenders: [{ kind: 'card', network: 'visa', last4: '0007', amountMinor: 1000, cardSpending: true }],
  };
}

/** Receipt 2, an online order: one shipped and delivered line an agent filed (sure enough), paid by a card and a Shop Card. */
export function onlineDetailFixture(): RetailApiReceiptDetail {
  return {
    receiptRef: receiptRef(2), channel: 'online', state: 'active', quarantineReason: null, memberships: [MEMBERSHIP_A],
    date: '2026-10-20', localTime: null, sign: 'sale', status: 'delivered', currency: 'USD',
    totals: { subtotalMinor: 2000, taxMinor: 0, instantSavingsMinor: null, discountMinor: 0, shippingMinor: 0, feesMinor: 0,
      storedValueMinor: 500, totalMinor: 1500 },
    taxLegends: [],
    lines: [line(8, {
      kind: 'item', itemNumber: '4567890', title: 'SAMPLE BLENDER', quantity: 1, unitPriceMinor: 2000, amountMinor: 2000, shippingMinor: 0,
      fulfilment: 'parcel',
      events: { shipped: [{ quantity: 1, date: '2026-10-21' }], delivered: [{ quantity: 1, date: '2026-10-23' }], cancelled: [], returned: [] },
      shipments: [{ shipmentRef: shipmentRef(1), shippedDate: '2026-10-21', deliveredDate: '2026-10-23', estimatedArrivalDate: '2026-10-24',
        carrier: 'ups' }],
      category: categoryFixture('home-kitchen/small-appliances', { source: 'agent', confidenceBp: 9200 }),
    })],
    tenders: [
      { kind: 'card', network: 'mastercard', last4: '0011', amountMinor: 1500, cardSpending: true },
      { kind: 'shop-card', network: 'unknown', last4: null, amountMinor: 500, cardSpending: false },
    ],
  };
}

/** Receipt 4, a gas receipt: one fuel line, as stated, filed under Automotive › Fuel by its department's review. */
export function gasDetailFixture(): RetailApiReceiptDetail {
  return {
    receiptRef: receiptRef(4), channel: 'gas', state: 'active', quarantineReason: null, memberships: [MEMBERSHIP_B],
    date: '2026-09-30', localTime: '07:41:09', sign: 'sale', status: null, currency: 'USD',
    totals: { subtotalMinor: 4567, taxMinor: 0, instantSavingsMinor: null, discountMinor: null, shippingMinor: null, feesMinor: null,
      storedValueMinor: null, totalMinor: 4567 },
    taxLegends: [],
    lines: [line(9, { kind: 'fuel', title: 'SAMPLE REGULAR', amountMinor: 4567, fuel: { gallons: '13.203', unitPrice: '3.459' },
      category: categoryFixture('automotive/fuel', { source: 'department-review' }) })],
    tenders: [{ kind: 'card', network: 'visa', last4: '0007', amountMinor: 4567, cardSpending: true }],
  };
}

export function receiptFixture(receipt: RetailApiReceiptDetail = warehouseDetailFixture()): RetailApiReceiptPresent {
  return { format: 'holdr.retail-costco-receipt', version: 2, state: 'present', receipt };
}

/** A body as the wire carries it: a deep, plain copy the tests may change freely. */
export const wire = <T>(body: T): Record<string, unknown> => JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
