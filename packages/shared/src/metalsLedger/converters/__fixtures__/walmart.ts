/**
 * A synthetic Walmart account folder for the `walmart@1` converter's tests: the consolidated `walmart.json`, its order
 * list's pages (`raw/list-pNNN.json`) and each order's raw detail (`raw/detail-<id>.json`), laid out as the pull
 * writes them. Built on the capture readers' synthetic captures, so every value is invented: order numbers, sellers,
 * items, amounts, card endings and cursors. None comes from a household capture.
 */

import { METALS_CONVERTER, type MetalsCaptureFile, type MetalsCaptureFolder } from '../common.js';
import {
  syntheticWalmartCapture,
  syntheticWalmartDisplayId,
  type SyntheticWalmartGroup,
  type SyntheticWalmartOrder,
  type SyntheticWalmartSpec,
} from '../../captures/__fixtures__/walmartCapture.js';

export {
  SYNTHETIC_WALMART_CAPTURED_AT,
  SYNTHETIC_WALMART_CARD,
  SYNTHETIC_WALMART_GIFT_CARD,
  SYNTHETIC_WALMART_SELLER,
  syntheticWalmartCapture,
  syntheticWalmartDisplayId,
  syntheticWalmartMoneyText,
  syntheticWalmartOrderId,
  syntheticWalmartSensitiveValues,
  syntheticWalmartSpec,
  type SyntheticWalmartGroup,
  type SyntheticWalmartItem,
  type SyntheticWalmartOrder,
  type SyntheticWalmartPayment,
  type SyntheticWalmartSpec,
} from '../../captures/__fixtures__/walmartCapture.js';

/** The page size Walmart's order list uses. */
export const SYNTHETIC_WALMART_PAGE_SIZE = 5;
/** When a synthetic folder's pull ran: a month after its orders, by day in every US zone. */
export const SYNTHETIC_WALMART_FOLDER_CAPTURED_AT = '2030-04-01T15:00:00.000Z';
/** A synthetic marketplace seller whose name passes the seller guard. */
export const SYNTHETIC_WALMART_BULLION_SELLER = 'SAMPLE BULLION SHOP';
/** A synthetic seller name the guard refuses (a run of four digits), so only its key is kept. */
export const SYNTHETIC_WALMART_NUMBERED_SELLER = 'SAMPLE SELLER 4242';
export const SYNTHETIC_WALMART_SECOND_CARD = '0019';

type Json = Record<string, unknown>;

export interface SyntheticWalmartFolder {
  consolidated: Json;
  listPages: Array<{ name: string; json: Json }>;
  rawDetails: Array<{ name: string; orderId: string; json: Json }>;
}

/**
 * A whole account folder: the readers' synthetic capture, with its order list split into pages of `pageSize` rows
 * (every page but the last full, the last with no next cursor) and the provenance stating them and when the pull ran.
 */
export function syntheticWalmartFolder(
  spec: SyntheticWalmartSpec,
  options: { pageSize?: number; capturedAt?: string } = {},
): SyntheticWalmartFolder {
  const pageSize = options.pageSize ?? SYNTHETIC_WALMART_PAGE_SIZE;
  const capturedAt = options.capturedAt ?? SYNTHETIC_WALMART_FOLDER_CAPTURED_AT;
  const capture = syntheticWalmartCapture(spec);
  const ids = capture.rawDetails.map((detail) => detail.orderId);
  const pageCount = Math.max(1, Math.ceil(ids.length / pageSize));
  const listPages = Array.from({ length: pageCount }, (_, index) => {
    const number = index + 1;
    const rows = spec.orders.slice(index * pageSize, number * pageSize).map((order, row) => ({
      id: ids[index * pageSize + row],
      displayId: syntheticWalmartDisplayId(order.seed),
      orderDate: order.orderDateRaw,
      title: 'SAMPLE ORDER TITLE',
    }));
    const purchaseHistory = {
      activeGroupsCount: 0,
      searchType: 'SAMPLE',
      wPlusMembershipStatus: 'SAMPLE',
      sentiment: 'SAMPLE',
      filterGroups: [],
      pageInfo: {
        nextPageCursor: number === pageCount ? null : `SAMPLE-NEXT-CURSOR-${number}`,
        prevPageCursor: number === 1 ? null : `SAMPLE-PREV-CURSOR-${number}`,
      },
      orders: rows,
      searchInfo: null,
    };
    const json: Json = number === 1
      ? { capturedAt, page: '/orders', ok: true, source: 'synthetic', purchaseHistory }
      : { capturedAt, page: null, ok: true, drained: number, op: 'PurchaseHistoryV3', status: 200, source: 'synthetic', purchaseHistory };
    return { name: `list-p${String(number).padStart(3, '0')}.json`, json };
  });
  const provenance = capture.consolidated.provenance as Json;
  provenance.capturedAt = capturedAt;
  provenance.list = {
    path: 'synthetic', how: 'synthetic', pages: pageCount, pageSize, rowsSeen: ids.length, statedTotal: null, lastPageHasNext: false,
  };
  return { consolidated: capture.consolidated, listPages, rawDetails: capture.rawDetails };
}

const encoder = new TextEncoder();
const bytesOf = (json: unknown) => encoder.encode(JSON.stringify(json));

/** The folder's files as the CLI hands them to a converter, in its layout's order. */
export function syntheticWalmartFiles(folder: SyntheticWalmartFolder): MetalsCaptureFile[] {
  return [
    { path: 'walmart.json', bytes: bytesOf(folder.consolidated) },
    ...folder.listPages.map((page) => ({ path: `raw/${page.name}`, bytes: bytesOf(page.json) })),
    ...folder.rawDetails.map((detail) => ({ path: `raw/${detail.name}`, bytes: bytesOf(detail.json) })),
  ];
}

/** The converter's input for a folder: the account folder `walmart` (no snapshot) and the converters' version. */
export function syntheticWalmartCaptureFolder(folder: SyntheticWalmartFolder, name = 'walmart'): MetalsCaptureFolder {
  return { folder: name, snapshot: null, files: syntheticWalmartFiles(folder), converterVersion: METALS_CONVERTER };
}

/** A delivered marketplace group of one item. */
export function syntheticWalmartGroup(
  line: number,
  name: string,
  qty: number,
  lineCents: number,
  extra: Partial<SyntheticWalmartGroup> = {},
): SyntheticWalmartGroup {
  return {
    fulfillmentType: 'FC_DELIVERY',
    detailedGroupType: 'DELIVERY',
    status: 'DELIVERED',
    statusParts: ['Delivered on ', 'Mar 08'],
    eventDate: '2030-03-08',
    deliveryDate: '2030-03-08',
    seller: { id: 'SAMPLESELLERID', name: SYNTHETIC_WALMART_BULLION_SELLER, isPro: true, shown: true, shippedByWalmart: false },
    items: [{ line, name, qty, lineCents }],
    ...extra,
  };
}

/**
 * An order of the given groups, paid in full by one card (its one stated total is the grand total). Its subtotal, like
 * Walmart's, leaves out the lines of cancelled groups.
 */
export function syntheticWalmartOrder(seed: number, groups: SyntheticWalmartGroup[], extra: Partial<SyntheticWalmartOrder> = {}): SyntheticWalmartOrder {
  const subTotal = groups
    .filter((group) => group.status !== 'CANCELED')
    .reduce((total, group) => total + group.items.reduce((sum, item) => sum + (item.lineCents ?? 0), 0), 0);
  const tax = Math.round(subTotal * 0.05);
  return {
    seed,
    orderDateRaw: '2030-03-01T10:00:00.000-05:00',
    orderAt: '2030-03-01T15:00:00.000Z',
    groups,
    subTotal,
    tax,
    grandTotal: subTotal + tax,
    payments: [{ type: 'CREDITCARD', cardType: 'VISA', last4: '0007', charged: [subTotal + tax] }],
    ...extra,
  };
}

/** Titles the tests read: what each one shows is asserted through the rules themselves, never hard-coded. */
export const SYNTHETIC_WALMART_TITLES = {
  /** A gold coin the coin specifications name: one American Eagle, a bare "oz", no qualifier. */
  eagle: 'American Gold Eagle 1 oz Coin',
  /** A gold bar whose stated mass is its fine content, with a stated purity. */
  fineBar: 'Sample Refinery 1 ozt Fine Gold Bar .9999',
  /** A silver round sold twenty to a unit. */
  silverPack: 'Sample Mint 1 oz Silver Round 20 Pack',
  widget: 'SAMPLE WIDGET',
  gadget: 'TESTNAME GADGET',
} as const;

/**
 * Seven orders covering what the converter decides: an admitted gold coin; a gold bar paid by a card and a gift card;
 * a silver pack picked up; and four orders with no metal line (a single charge, a refunded one, a two-group one, and
 * one paid by PayPal alone).
 */
export function syntheticWalmartMetalsSpec(): SyntheticWalmartSpec {
  const titles = SYNTHETIC_WALMART_TITLES;
  return {
    orders: [
      syntheticWalmartOrder(11, [syntheticWalmartGroup(1, titles.eagle, 1, 250_000)]),
      syntheticWalmartOrder(12, [syntheticWalmartGroup(1, titles.fineBar, 2, 400_000)], {
        payments: [
          { type: 'CREDITCARD', cardType: 'MASTERCARD', last4: SYNTHETIC_WALMART_SECOND_CARD, charged: [370_000] },
          { type: 'GIFTCARD', cardType: null, last4: '0011', charged: [50_000] },
        ],
      }),
      syntheticWalmartOrder(13, [syntheticWalmartGroup(1, titles.silverPack, 1, 60_000, {
        fulfillmentType: 'SC_PICKUP', detailedGroupType: 'PICKUP_CURBSIDE', status: 'PICKED_UP', statusParts: ['Picked up ', 'Mar 09'],
        eventDate: '2030-03-09', deliveryDate: null, seller: null,
      })]),
      syntheticWalmartOrder(14, [syntheticWalmartGroup(1, titles.widget, 1, 1_999, { seller: null })]),
      syntheticWalmartOrder(15, [syntheticWalmartGroup(1, titles.widget, 2, 3_998, { seller: null })], {
        refunds: [{ label: 'Refund', cents: -1_999 }],
        flags: { refunded: true },
        grandTotal: 3_998 + 200 - 1_999,
        payments: [{ type: 'CREDITCARD', cardType: 'AMEX', last4: '0007', charged: [3_998 + 200 - 1_999] }],
      }),
      syntheticWalmartOrder(16, [
        syntheticWalmartGroup(1, titles.widget, 1, 1_000, { seller: null }),
        syntheticWalmartGroup(2, titles.gadget, 1, 2_000, { seller: null }),
      ]),
      syntheticWalmartOrder(17, [syntheticWalmartGroup(1, titles.gadget, 1, 500, { seller: null })], {
        payments: [{ type: 'PAYPAL', cardType: 'PAYPAL', last4: null, charged: [525] }],
      }),
    ],
  };
}

/** Every invented value of the metals spec that must never appear in a report. */
export function syntheticWalmartMetalsSensitiveValues(): string[] {
  return [
    SYNTHETIC_WALMART_BULLION_SELLER, SYNTHETIC_WALMART_NUMBERED_SELLER, SYNTHETIC_WALMART_SECOND_CARD, '0007', '0011',
    'SAMPLESELLERID', 'SAMPLE WIDGET', 'TESTNAME GADGET', 'American Gold Eagle', 'Sample Refinery', 'Sample Mint',
    'SAMPLE-NEXT-CURSOR', 'SAMPLE ORDER TITLE', 'SAMPLE PAYMENT MESSAGE', '2,500.00', '250000', '4,000.00', '400000', '3700',
    ...[11, 12, 13, 14, 15, 16, 17].map((seed) => `9${String(seed).padStart(14, '0')}`),
  ];
}
