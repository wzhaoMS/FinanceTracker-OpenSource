/**
 * Synthetic CollectPure capture folders for the converter's tests: four invented sales of bullion, built by the
 * capture fixture's builder, as the files the CLI hands a converter (`{ path, bytes }`). Every value is invented.
 *
 * - Sale 11, complete: a 1 oz American Gold Eagle (coin specification) and a gold bar stated in troy ounces of fine gold
 *   (stated mass basis), placed, inspected and completed on New York evenings, so each of those steps' UTC date is the
 *   next day; paid by one ACH payout created on a New York evening.
 * - Sale 12, complete: twenty silver Eagles (no coin specification for silver), placed just after daylight time began.
 * - Sale 13, in transit: a gold bar stated in a bare `oz` beside a non-metal line, placed just after daylight time
 *   ended; not yet paid.
 * - Sale 14, cancelled: a tenth-ounce gold Maple Leaf, no fees, no payout.
 */

import {
  syntheticCollectPureCapture,
  syntheticPayoutId,
  syntheticSellOrderId,
  type SyntheticCollectPureCapture,
  type SyntheticCollectPureSpec,
} from '../../captures/__fixtures__/collectpureCapture.js';
import { METALS_CONVERTER, type MetalsCaptureFile, type MetalsCaptureFolder } from '../common.js';

const encoder = new TextEncoder();
const bytesOf = (json: unknown) => encoder.encode(JSON.stringify(json));

/** A synthetic capture's files, as the CLI reads them from the folder's layout. */
export function syntheticCollectPureFiles(capture: SyntheticCollectPureCapture): MetalsCaptureFile[] {
  return [
    { path: 'collectpure.json', bytes: bytesOf(capture.consolidated) },
    ...capture.rawSellOrders.map((file) => ({ path: `raw/${file.name}`, bytes: bytesOf(file.json) })),
    ...capture.payoutHistoryPages.map((file) => ({ path: `raw/${file.name}`, bytes: bytesOf(file.json) })),
    ...capture.stats.map((file) => ({ path: `raw/${file.name}`, bytes: bytesOf(file.json) })),
  ];
}

/** A synthetic capture as the folder a converter receives. */
export function syntheticCollectPureFolder(capture: SyntheticCollectPureCapture, snapshot: string | null = null): MetalsCaptureFolder {
  return { folder: 'collectpure', snapshot, files: syntheticCollectPureFiles(capture), converterVersion: METALS_CONVERTER };
}

export const COLLECTPURE_EAGLE_TITLE = '2024 1 oz American Gold Eagle BU';
export const COLLECTPURE_FINE_BAR_TITLE = 'Gold Bar 1 ozt Fine Gold .9999';
export const COLLECTPURE_SILVER_EAGLE_TITLE = '1 oz American Silver Eagle BU';
export const COLLECTPURE_BARE_OZ_BAR_TITLE = '1 oz Gold Bar - Sample Refinery (In Assay) .9999 Fine';
export const COLLECTPURE_OTHER_TITLE = 'Sample Display Case';
export const COLLECTPURE_MAPLE_TITLE = '1/10 oz Gold Maple Leaf Coin';
/** The title each sale's one optional fee states, which restates its platform fee: never stored or shown. */
export const COLLECTPURE_OPTION_TITLE = 'SAMPLE OPTION';

/**
 * The four sales; payout-history pages hold one payout each, so the pager runs to a second page. Each sale with a
 * platform fee states one optional fee restating it, in the same cents, as every real sale does.
 */
export function syntheticCollectPureSalesSpec(): SyntheticCollectPureSpec {
  return {
    payoutPageSize: 1,
    sellOrders: [
      {
        seed: 11,
        status: 'order_complete',
        placedAt: '2025-10-02T01:30:00.000Z',
        completeAt: '2025-10-09T03:30:00.000Z',
        timeline: [
          { status: 'pending_confirmation', at: '2025-10-02T01:30:00.000Z' },
          { status: 'ready_for_shipment', at: '2025-10-02T02:00:00.000Z' },
          { status: 'in_transit', at: '2025-10-03T15:00:00.000Z' },
          { status: 'items_received', at: '2025-10-07T14:00:00.000Z' },
          { status: 'check_in_progress', at: '2025-10-07T16:00:00.000Z' },
          { status: 'check_in_complete', at: '2025-10-08T03:30:00.000Z' },
          { status: 'order_complete', at: '2025-10-09T03:30:00.000Z' },
        ],
        lines: [
          {
            id: 7101, sku: 'CP-EAGLE-1OZ', name: COLLECTPURE_EAGLE_TITLE, program: 'Sell to Dealer', premium: 'troy_ounce', qty: 2, price: 265_013,
            spotPremium: -1.5, spotPremiumDollar: -4_013, status: 'Item Complete', inspection: { received: true, passed: true, buyerPaid: true },
          },
          {
            id: 7102, sku: 'CP-BAR-1OZT', name: COLLECTPURE_FINE_BAR_TITLE, program: 'Sell to Dealer', premium: 'troy_ounce', qty: 1, price: 268_027,
            spotPremium: 2.2500000000000004, spotPremiumDollar: 5_897, status: 'Item Complete', inspection: { received: true, passed: true, buyerPaid: true },
          },
        ],
        shipping: -3_011,
        processingFee: -7_981,
        optionalFees: [{ title: COLLECTPURE_OPTION_TITLE, fee: -7_981 }],
        breakdown: [
          { label: 'Subtotal', cents: 798_053 },
          { label: 'Insured Shipping', cents: -3_011 },
          { label: 'Platform Fee (1%)', cents: -7_981 },
          { label: 'Total Payout', cents: 787_061 },
        ],
        payouts: [{ amount: 787_061, status: 'complete', date: '2025-10-10', createdAt: '2025-10-10T02:15:00.000Z' }],
        shipment: { carrier: 'SAMPLE CARRIER', deliveredAt: '2025-10-07T13:00:00.000Z' },
      },
      {
        seed: 12,
        status: 'order_complete',
        placedAt: '2025-03-10T04:30:00.000Z',
        completeAt: '2025-03-15T14:00:00.000Z',
        timeline: [
          { status: 'pending_confirmation', at: '2025-03-10T04:30:00.000Z' },
          { status: 'ready_for_shipment', at: '2025-03-10T12:00:00.000Z' },
          { status: 'in_transit', at: '2025-03-11T15:00:00.000Z' },
          { status: 'items_received', at: '2025-03-14T15:00:00.000Z' },
          { status: 'check_in_progress', at: '2025-03-14T18:00:00.000Z' },
          { status: 'check_in_complete', at: '2025-03-14T20:00:00.000Z' },
          { status: 'order_complete', at: '2025-03-15T14:00:00.000Z' },
        ],
        lines: [{
          id: 7201, sku: 'CP-SAE-1OZ', name: COLLECTPURE_SILVER_EAGLE_TITLE, program: null, premium: 'unit', qty: 20, price: 3_157, spotPremium: 3.0123456789012345, spotPremiumDollar: 93,
          status: 'Item Complete', inspection: null,
        }],
        shipping: -1_513,
        processingFee: -631,
        optionalFees: [{ title: COLLECTPURE_OPTION_TITLE, fee: -631 }],
        breakdown: [
          { label: 'Subtotal', cents: 63_140 },
          { label: 'Insured Shipping', cents: -1_513 },
          { label: 'Platform Fee (1%)', cents: -631 },
          { label: 'Total Payout', cents: 60_996 },
        ],
        payouts: [{ amount: 60_996, status: 'complete', date: '2025-03-17' }],
        shipment: { carrier: 'SAMPLE CARRIER', deliveredAt: '2025-03-14T14:00:00.000Z' },
      },
      {
        seed: 13,
        status: 'in_transit',
        placedAt: '2025-11-03T04:30:00.000Z',
        timeline: [
          { status: 'pending_confirmation', at: '2025-11-03T04:30:00.000Z' },
          { status: 'ready_for_shipment', at: '2025-11-03T05:00:00.000Z' },
          { status: 'in_transit', at: '2025-11-04T16:00:00.000Z' },
        ],
        lines: [
          {
            id: 7301, sku: 'CP-BAR-1OZ', name: COLLECTPURE_BARE_OZ_BAR_TITLE, program: 'Sell to Dealer', premium: 'troy_ounce', qty: 1, price: 270_019,
            spotPremium: 0.9876543210123457, spotPremiumDollar: 2_642, status: 'Item Pending', inspection: { received: false, passed: false, buyerPaid: false },
          },
          { id: 7302, sku: 'CP-CASE', name: COLLECTPURE_OTHER_TITLE, program: null, premium: 'unit', qty: 1, price: 1_009, status: 'Item Pending' },
        ],
        shipping: -2_017,
        processingFee: -2_711,
        optionalFees: [{ title: COLLECTPURE_OPTION_TITLE, fee: -2_711 }],
        breakdown: [
          { label: 'Subtotal', cents: 271_028 },
          { label: 'Insured Shipping', cents: -2_017 },
          { label: 'Platform Fee (1%)', cents: -2_711 },
          { label: 'Total Payout', cents: 266_300 },
        ],
        shipment: { carrier: 'SAMPLE CARRIER', deliveredAt: null },
      },
      {
        seed: 14,
        status: 'cancelled',
        placedAt: '2025-06-01T15:00:00.000Z',
        timeline: [{ status: 'pending_confirmation', at: '2025-06-01T15:00:00.000Z' }],
        lines: [{ id: 7401, sku: 'CP-MAPLE-TENTH', name: COLLECTPURE_MAPLE_TITLE, program: null, premium: 'unit', qty: 1, price: 30_029, status: null }],
        breakdown: [{ label: 'Subtotal', cents: 30_029 }, { label: 'Total Payout', cents: 30_029 }],
      },
    ],
  };
}

/** The four sales' capture. */
export const syntheticCollectPureSales = (): SyntheticCollectPureCapture => syntheticCollectPureCapture(syntheticCollectPureSalesSpec());

/** The same four sales as a nested snapshot holds them: raw files with the snapshot's capturedAt, status and source. */
export const syntheticCollectPureSalesSnapshot = (): SyntheticCollectPureCapture =>
  syntheticCollectPureCapture({ ...syntheticCollectPureSalesSpec(), snapshot: true });

/** Every invented value of the four sales that no report, issue or refusal may show, and no payload may hold. */
export function syntheticCollectPureSalesSecrets(): string[] {
  return [
    ...[11, 12, 13, 14].map(syntheticSellOrderId), syntheticPayoutId(11, 0), syntheticPayoutId(12, 0), 'SAMPLECONF', 'SAMPLE BANK',
    'SAMPLE INSPECTION NOTE', 'SAMPLE PRICE LOCK TEXT', 'SAMPLE CARRIER', 'SAMPLE STATUS LABEL', 'SAMPLE BADGE', 'SAMPLE-CODE', 'SAMPLE PARSE',
    'SAMPLE ESTIMATE', 'SAMPLE STEP', COLLECTPURE_OPTION_TITLE,
  ];
}

/** The four sales' amounts, product names, SKUs and programs, which only the owner-only payload may hold. */
export function syntheticCollectPureSalesPayloadValues(): string[] {
  return [
    '265013', '268027', '798053', '787061', '63140', '60996', '271028', '266300', '30029', '40.13', '58.97', '26.42', COLLECTPURE_EAGLE_TITLE, COLLECTPURE_FINE_BAR_TITLE, COLLECTPURE_SILVER_EAGLE_TITLE,
    COLLECTPURE_BARE_OZ_BAR_TITLE, COLLECTPURE_MAPLE_TITLE, COLLECTPURE_OTHER_TITLE, 'CP-EAGLE-1OZ', 'CP-BAR-1OZT', 'CP-SAE-1OZ', 'Sell to Dealer', '0007',
  ];
}
