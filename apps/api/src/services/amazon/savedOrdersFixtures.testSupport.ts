import type { SavedOrdersFile } from './savedOrders.js';

// Entirely synthetic: invented order IDs, ASINs, titles, card endings, digests and amounts.
export const SAVED_CLASSIC = '000-0000011-0000011';
export const SAVED_FRESH = '000-0000012-0000012';
export const SAVED_SECRETS = [SAVED_CLASSIC, SAVED_FRESH, 'SYNTH00011', 'SYNTHF0011', 'Synthetic saved widget',
  'Synthetic saved gadget', 'Synthetic large eggs', 'Synthetic bananas', 'Synthetic whole milk', 'Synthetic sourdough loaf',
  'Synthetic rye loaf'];
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
const hex = (c: string) => c.repeat(64);

/**
 * A saved-orders file of two complete single-card orders: a classic one (2 lines, 1000 + 0 shipping + 100 tax = 1100,
 * dated 2026-09-01) and a Fresh one (an Item List of 4 rows: each, weighed, missing and substituted; 1022 + 995 delivery
 * + 52 tax + 300 tip = 2369, dated 2026-09-10), both on the synthetic Visa ending 9001.
 */
export function syntheticSavedOrders(): SavedOrdersFile {
  return {
    format: 'holdr.amazon-saved-orders', version: 1,
    provenance: { targetsSha256: hex('1'), indexSha256: hex('2'),
      parser: { name: 'holdr-amazon-saved-pages', version: '1.0.0', sha256: hex('3') } },
    orders: [{
      orderId: SAVED_CLASSIC, date: '2026-09-01', family: 'classic', total: usd(1100),
      summary: [{ kind: 'items-subtotal', money: usd(1000) }, { kind: 'shipping', money: usd(0) },
        { kind: 'tax', money: usd(100) }, { kind: 'grand-total', money: usd(1100) }],
      payment: { kind: 'card', network: 'visa', last4: '9001' },
      items: [{ lineOrdinal: 0, itemId: 'SYNTH00011', title: 'Synthetic saved widget', quantity: 1, unitPrice: usd(600) },
        { lineOrdinal: 1, itemId: null, title: 'Synthetic saved gadget', quantity: 2, unitPrice: usd(200) }],
      fresh: null,
      pages: [{ kind: 'details', sha256: hex('a') }, { kind: 'invoice', sha256: hex('b') }],
    }, {
      orderId: SAVED_FRESH, date: '2026-09-10', family: 'uff', total: usd(2369),
      summary: [{ kind: 'items-subtotal', money: usd(1022) }, { kind: 'shipping', money: usd(995) },
        { kind: 'tax', money: usd(52) }, { kind: 'tip', money: usd(300) }, { kind: 'grand-total', money: usd(2369) }],
      payment: { kind: 'card', network: 'visa', last4: '9001' },
      items: null,
      fresh: { statedCount: 4, rows: 4, lines: [
        { lineOrdinal: 0, title: 'Synthetic large eggs 12 ct', asin: 'SYNTHF0011', status: 'listed', quantity: 1, weight: null,
          unitPrice: { money: usd(499), per: 'each' }, linePrice: usd(499), replaces: null },
        { lineOrdinal: 1, title: 'Synthetic bananas', asin: null, status: 'listed', quantity: null,
          weight: { value: '2.5', unit: 'lb', basis: 'actual' }, unitPrice: { money: usd(69), per: 'lb' }, linePrice: usd(173),
          replaces: null },
        { lineOrdinal: 2, title: 'Synthetic whole milk', asin: null, status: 'missing', quantity: 1, weight: null, unitPrice: null,
          linePrice: null, replaces: null },
        { lineOrdinal: 3, title: 'Synthetic sourdough loaf', asin: null, status: 'substituted', quantity: 1, weight: null,
          unitPrice: { money: usd(350), per: 'each' }, linePrice: usd(350), replaces: 'Synthetic rye loaf' },
      ] },
      pages: [{ kind: 'details', sha256: hex('c') }, { kind: 'itemmod', sha256: hex('d') }],
    }],
  };
}
/** The card rows that settle the two synthetic saved orders, a day after each order. */
export const SAVED_CHARGES = [{ transactionDate: '2026-09-02', amountMinor: 1100 }, { transactionDate: '2026-09-11', amountMinor: 2369 }];
/** The kit's own synthetic complete order (fixtures.testSupport.ts syntheticCompleteOrder), as the importer shows it. */
export const KIT_ORDER = '000-0000001-0000001';
export const KIT_SECRETS = [KIT_ORDER, 'SYNTH00001', 'SYNTH00002', 'Synthetic blue widget', 'Synthetic second widget'];
/**
 * A saved read of the kit's own order that conflicts with what the kit showed on one fact: its card (an unbound ending),
 * its date (outside every charge's window), or its total (a self-consistent 1150 with 150 of tax; no such charge).
 */
export function kitConflict(conflict: 'card' | 'date' | 'total'): SavedOrdersFile['orders'][number] {
  const tax = conflict === 'total' ? 150 : 100;
  return {
    orderId: KIT_ORDER, date: conflict === 'date' ? '2026-06-01' : '2026-09-01', family: 'classic', total: usd(1000 + tax),
    summary: [{ kind: 'items-subtotal', money: usd(1000) }, { kind: 'shipping', money: usd(0) },
      { kind: 'tax', money: usd(tax) }, { kind: 'grand-total', money: usd(1000 + tax) }],
    payment: { kind: 'card', network: 'visa', last4: conflict === 'card' ? '9003' : '9001' },
    items: [{ lineOrdinal: 0, itemId: 'SYNTH00001', title: 'Synthetic blue widget', quantity: 1, unitPrice: usd(500) },
      { lineOrdinal: 1, itemId: 'SYNTH00002', title: 'Synthetic second widget', quantity: 1, unitPrice: usd(500) }],
    fresh: null,
    pages: [{ kind: 'details', sha256: hex('f') }],
  };
}
