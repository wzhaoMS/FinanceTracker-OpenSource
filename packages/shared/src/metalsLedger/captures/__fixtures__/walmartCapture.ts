/**
 * Synthetic Walmart captures for tests: the pull's `holdr-retail-capture/walmart@1` consolidated file and its raw
 * `detail-<orderId>.json` files, built from one compact spec with the field names the real capture uses, so the two
 * agree the way the capture's own normalizer makes them agree. Every value is invented: order and line numbers,
 * sellers, stores, items, amounts, card endings and tracking. None comes from a household capture.
 *
 * Amounts in specs are integer cents. Raw details show them as page text ('$1,234.56'), as Walmart does.
 */

export const SYNTHETIC_WALMART_CAPTURED_AT = '2026-01-02T03:04:05.000Z';
export const SYNTHETIC_WALMART_CARD = '0007';
export const SYNTHETIC_WALMART_GIFT_CARD = '0011';
export const SYNTHETIC_WALMART_TRACKING = '0042';
export const SYNTHETIC_WALMART_SELLER = 'SAMPLE SELLER';
export const SYNTHETIC_WALMART_SELLER_ID = 'SAMPLESELLERID';
export const SYNTHETIC_WALMART_STORE = 'SAMPLE STORE';

/** A synthetic 15-digit order number, built at run time so no long digit run is written in source. */
export const syntheticWalmartOrderId = (seed: number) => `9${String(seed).padStart(14, '0')}`;
/** The order number as Walmart displays it. */
export const syntheticWalmartDisplayId = (seed: number) => {
  const id = syntheticWalmartOrderId(seed);
  return `${id.slice(0, 7)}-${id.slice(7)}`;
};

/** Cents as Walmart's pages show them: '$1,234.56', '-$1.00'. */
export function syntheticWalmartMoneyText(cents: number): string {
  const whole = String(Math.floor(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}$${whole}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
}

export type SyntheticWalmartPaymentType = 'CREDITCARD' | 'GIFTCARD' | 'CLOSEDLOOP' | 'PAYPAL';

export interface SyntheticWalmartItem {
  /** The line's id (a number, as Walmart gives it). */
  line: number;
  name: string;
  qty: number;
  /** The whole line's price in cents; null when the page shows none. */
  lineCents: number | null;
  /** The page's text for the price when it isn't the plain amount ('Free'). */
  lineText?: string;
}

export interface SyntheticWalmartGroup {
  fulfillmentType: 'FC_DELIVERY' | 'SC_PICKUP' | 'SC_DELIVERY' | null;
  detailedGroupType: 'DELIVERY' | 'PICKUP_CURBSIDE' | 'DFS' | null;
  /** The raw detail names the detailed type `derivedFulfillmentType` instead. */
  derivedKey?: boolean;
  status: 'DELIVERED' | 'CANCELED' | 'PICKED_UP' | null;
  /** The status message's parts as the page shows them; joined and trimmed they are the status text. */
  statusParts?: string[];
  /** The capture's own date for the status message. */
  eventDate?: string | null;
  deliveryDate?: string | null;
  readyForPickupDate?: string | null;
  seller?: { id: string | number; name: string; isPro: boolean; shown: boolean; shippedByWalmart: boolean } | null;
  store?: string | null;
  trackingLast4?: string | null;
  items: SyntheticWalmartItem[];
}

export interface SyntheticWalmartAmount {
  label: string;
  cents: number;
  /** The page's text for it when it isn't the plain amount ('Free'). */
  text?: string;
}

export interface SyntheticWalmartPayment {
  type: SyntheticWalmartPaymentType;
  cardType: string | null;
  /** The ending its description shows ('Ending in 0007'); null for none. */
  last4: string | null;
  /** Cents charged: at most one entry in a well-formed capture. */
  charged: number[];
}

export interface SyntheticWalmartOrder {
  seed: number;
  /** Walmart's own local date and time for the order, with its offset. */
  orderDateRaw: string;
  /** The capture's UTC instant for it. */
  orderAt: string;
  /** The raw detail's groups key: `groups_2101` unless set. */
  groupsKey?: string;
  groups: SyntheticWalmartGroup[];
  subTotal: number;
  tax: number;
  grandTotal: number;
  /** The raw detail states the grand total as `orderTotal` instead. */
  orderTotalKey?: boolean;
  driverTip?: number | null;
  grandTotalWithTips?: number | null;
  fees?: SyntheticWalmartAmount[];
  /** The raw detail gives the fees as one object, not a list (the spec has exactly one fee). */
  singleFee?: boolean;
  discounts?: SyntheticWalmartAmount[];
  refunds?: SyntheticWalmartAmount[];
  donations?: SyntheticWalmartAmount[];
  payments: SyntheticWalmartPayment[];
  refundPayments?: Array<{ type: SyntheticWalmartPaymentType; cardType: string | null; last4: string | null; amounts: number[] }>;
  chargeHistoryEntries?: number | null;
  flags?: Partial<{ cancelled: boolean; partlyCancelled: boolean; refunded: boolean; returned: boolean }>;
  isInStore?: boolean;
}

export interface SyntheticWalmartSpec {
  schema?: string;
  orders: SyntheticWalmartOrder[];
}

export interface SyntheticWalmartCapture {
  consolidated: Record<string, unknown>;
  rawDetails: Array<{ name: string; orderId: string; json: Record<string, unknown> }>;
}

const textOf = (cents: number, text?: string) => text ?? syntheticWalmartMoneyText(cents);
/** The consolidated file's money, as the capture writes it. */
const money = (cents: number, text?: string, label: string | null = null) => ({ cents, currency: 'USD', raw: textOf(cents, text), label });
/** A raw detail's price value. */
const priceValue = (cents: number, text?: string) => ({ displayValue: textOf(cents, text), value: cents / 100 });
const labeledPrice = (amount: SyntheticWalmartAmount) => ({ label: amount.label, ...priceValue(amount.cents, amount.text) });
const labeledMoney = (amount: SyntheticWalmartAmount) => ({ label: amount.label, amount: money(amount.cents, amount.text, amount.label) });
const description = (payment: { type: SyntheticWalmartPaymentType; last4: string | null }) => {
  if (payment.last4 === null) return null;
  return payment.type === 'GIFTCARD' ? `Gift card ending in ${payment.last4}` : `Ending in ${payment.last4}`;
};
const usItemIdOf = (line: number) => String(500_000_000 + line);
const offerIdOf = (seed: number, line: number) => `SAMPLEOFFER${seed}X${line}`;

function rawGroup(spec: SyntheticWalmartGroup, index: number, seed: number) {
  return {
    id: index + 1,
    fulfillmentType: spec.fulfillmentType,
    [spec.derivedKey === true ? 'derivedFulfillmentType' : 'detailedGroupType']: spec.detailedGroupType,
    status: spec.status === null && spec.statusParts === undefined
      ? null
      : { statusType: spec.status, message: { parts: (spec.statusParts ?? []).map((text) => ({ text })) } },
    deliveryDate: spec.deliveryDate ? `${spec.deliveryDate}T17:00:00.000Z` : null,
    rfpDate: spec.readyForPickupDate ? `${spec.readyForPickupDate}T15:00:00.000Z` : null,
    seller: spec.seller ? { id: spec.seller.id, name: spec.seller.name, isPro: spec.seller.isPro } : null,
    showSeller: spec.seller?.shown ?? false,
    isShippedByWalmart: spec.seller?.shippedByWalmart ?? true,
    store: spec.store ? { name: spec.store } : null,
    shipment: spec.trackingLast4 ? { trackingNumber: `SAMPLE-TRACKING-${spec.trackingLast4}`, isExternalTracking: false } : null,
    items: spec.items.map((item) => ({
      id: item.line,
      quantity: item.qty,
      productInfo: { name: item.name, usItemId: usItemIdOf(item.line), offerId: offerIdOf(seed, item.line) },
      priceInfo: item.lineCents === null ? null : { linePrice: priceValue(item.lineCents, item.lineText) },
    })),
  };
}

function listedGroup(spec: SyntheticWalmartGroup, index: number, seed: number) {
  const text = (spec.statusParts ?? []).join('').trim();
  return {
    groupId: String(index + 1),
    fulfillmentType: spec.fulfillmentType,
    detailedGroupType: spec.detailedGroupType,
    status: { type: spec.status, text: text === '' ? null : text, eventDate: spec.eventDate ?? null },
    deliveryMessage: { text: 'SAMPLE DELIVERY MESSAGE' },
    deliveryDate: spec.deliveryDate ?? null,
    readyForPickupDate: spec.readyForPickupDate ?? null,
    seller: spec.seller
      ? {
        id: spec.seller.id, name: spec.seller.name, isPro: spec.seller.isPro,
        shownAsMarketplaceSeller: spec.seller.shown, shippedByWalmart: spec.seller.shippedByWalmart,
      }
      : null,
    store: spec.store ? { name: spec.store } : null,
    shipment: spec.trackingLast4 ? { trackingLast4: spec.trackingLast4, isExternalTracking: false } : null,
    items: spec.items.map((item) => ({
      lineId: item.line,
      name: item.name,
      usItemId: usItemIdOf(item.line),
      offerId: offerIdOf(seed, item.line),
      qty: item.qty,
      linePrice: item.lineCents === null ? null : money(item.lineCents, item.lineText),
      unitPrice: item.lineCents === null || item.qty === 0 ? null : money(Math.round(item.lineCents / item.qty)),
      // The capture's own readings, which Holdr never reads: deliberately set, so a test can see them dropped.
      isPreciousMetal: true,
      metal: 'SAMPLE-CODE',
      weightOztPerUnit: 1,
      weightParsedFrom: 'SAMPLE PARSE',
      statusCode: 'SAMPLE-STATUS',
    })),
  };
}

function buildOrder(spec: SyntheticWalmartOrder) {
  const orderId = syntheticWalmartOrderId(spec.seed);
  const fees = spec.fees ?? [];
  const discounts = spec.discounts ?? [];
  const refunds = spec.refunds ?? [];
  const donations = spec.donations ?? [];
  const optional = (cents: number | null | undefined) => (cents === null || cents === undefined ? null : money(cents));
  const priceDetails: Record<string, unknown> = {
    subTotal: priceValue(spec.subTotal),
    taxTotal: priceValue(spec.tax),
    [spec.orderTotalKey === true ? 'orderTotal' : 'grandTotal']: priceValue(spec.grandTotal),
    fees: spec.singleFee === true ? labeledPrice(fees[0]) : fees.map(labeledPrice),
    discounts: discounts.map(labeledPrice),
    refund: refunds.map(labeledPrice),
    donations: donations.map(labeledPrice),
  };
  if (spec.driverTip !== null && spec.driverTip !== undefined) priceDetails.driverTip = priceValue(spec.driverTip);
  if (spec.grandTotalWithTips !== null && spec.grandTotalWithTips !== undefined) priceDetails.grandTotalWithTips = priceValue(spec.grandTotalWithTips);
  const raw = {
    order: {
      id: orderId,
      displayId: syntheticWalmartDisplayId(spec.seed),
      orderDate: spec.orderDateRaw,
      type: 'GLASS',
      title: 'SAMPLE ORDER TITLE',
      [spec.groupsKey ?? 'groups_2101']: spec.groups.map((group, index) => rawGroup(group, index, spec.seed)),
      priceDetails,
      paymentMethods: spec.payments.map((payment) => ({
        paymentType: payment.type,
        cardType: payment.cardType,
        description: description(payment),
        displayValues: payment.charged.map((cents) => syntheticWalmartMoneyText(cents)),
        message: 'SAMPLE PAYMENT MESSAGE',
      })),
    },
    capturedAt: SYNTHETIC_WALMART_CAPTURED_AT,
  };
  const statusTypes = [...new Set(spec.groups.map((group) => group.status).filter((status) => status !== null))];
  const consolidated = {
    orderId,
    displayId: syntheticWalmartDisplayId(spec.seed),
    orderDate: spec.orderDateRaw.slice(0, 10),
    orderDateRaw: spec.orderDateRaw,
    orderAt: spec.orderAt,
    timezone: 'Etc/UTC',
    type: 'GLASS',
    title: 'SAMPLE ORDER TITLE',
    isInStore: spec.isInStore ?? false,
    itemCount: spec.groups.reduce((total, group) => total + group.items.length, 0),
    statusTypes,
    groups: spec.groups.map((group, index) => listedGroup(group, index, spec.seed)),
    amounts: {
      subTotal: money(spec.subTotal),
      tax: money(spec.tax),
      grandTotal: money(spec.grandTotal),
      grandTotalWithTips: optional(spec.grandTotalWithTips),
      driverTip: optional(spec.driverTip),
      fees: fees.map(labeledMoney),
      discounts: discounts.map(labeledMoney),
      refunds: refunds.map(labeledMoney),
      donations: donations.map(labeledMoney),
    },
    payments: spec.payments.map((payment) => ({
      paymentType: payment.type,
      cardType: payment.cardType,
      description: description(payment),
      last4: payment.last4,
      charged: payment.charged.map((cents) => money(cents)),
      message: 'SAMPLE PAYMENT MESSAGE',
    })),
    refundPayments: (spec.refundPayments ?? []).map((payment) => ({
      paymentType: payment.type,
      cardType: payment.cardType,
      description: description(payment),
      last4: payment.last4,
      amounts: payment.amounts.map((cents) => money(cents)),
      message: null,
    })),
    chargeHistory: spec.chargeHistoryEntries === null || spec.chargeHistoryEntries === undefined
      ? null
      : { title: 'SAMPLE CHARGE TITLE', message: 'SAMPLE CHARGE MESSAGE', entries: spec.chargeHistoryEntries },
    flags: { cancelled: false, partlyCancelled: false, refunded: false, returned: false, ...spec.flags },
    // The capture's own flag, which Holdr never reads.
    hasPreciousMetal: true,
    detailCaptured: true,
    detailCapturedAt: SYNTHETIC_WALMART_CAPTURED_AT,
  };
  return { orderId, raw, consolidated };
}

/** A whole synthetic Walmart capture: the consolidated file and one raw detail per order. */
export function syntheticWalmartCapture(spec: SyntheticWalmartSpec): SyntheticWalmartCapture {
  const orders = spec.orders.map(buildOrder);
  return {
    consolidated: {
      schema: spec.schema ?? 'holdr-retail-capture/walmart@1',
      provenance: {
        source: 'walmart.com',
        capturedBy: 'synthetic',
        capturedAt: SYNTHETIC_WALMART_CAPTURED_AT,
        currency: 'USD',
        dateNote: 'synthetic',
        list: { path: 'synthetic', how: 'synthetic', pages: 1, pageSize: 10, rowsSeen: orders.length, statedTotal: null, lastPageHasNext: false },
        details: { path: 'synthetic', how: 'synthetic', captured: orders.length, of: orders.length },
        sanitization: 'synthetic',
        rawFilesRescrubbed: 0,
      },
      orders: orders.map((order) => order.consolidated),
    },
    rawDetails: orders.map((order) => ({ name: `detail-${order.orderId}.json`, orderId: order.orderId, json: order.raw })),
  };
}

/**
 * Three orders with one of everything the readers handle: a marketplace delivery with a `Free` fee given as one object,
 * a discount, a negative refund and a card plus a gift card; a curbside pickup under a plain `groups` key whose grand
 * total is `orderTotal` and whose detailed type is `derivedFulfillmentType`; a cancelled delivery from a store with a
 * driver tip, a donation, an unpriced item and nothing charged.
 */
export function syntheticWalmartSpec(): SyntheticWalmartSpec {
  return {
    orders: [
      {
        seed: 1,
        orderDateRaw: '2025-03-01T10:15:00.000-05:00',
        orderAt: '2025-03-01T15:15:00.000Z',
        groups: [{
          fulfillmentType: 'FC_DELIVERY',
          detailedGroupType: 'DELIVERY',
          status: 'DELIVERED',
          statusParts: ['Delivered on ', 'Mar 04', ' '],
          eventDate: '2025-03-04',
          deliveryDate: '2025-03-04',
          seller: { id: SYNTHETIC_WALMART_SELLER_ID, name: SYNTHETIC_WALMART_SELLER, isPro: true, shown: true, shippedByWalmart: false },
          trackingLast4: SYNTHETIC_WALMART_TRACKING,
          items: [
            { line: 1, name: 'SAMPLE WIDGET', qty: 2, lineCents: 123_456 },
            { line: 2, name: 'TESTNAME GADGET', qty: 1, lineCents: 0, lineText: 'Free' },
          ],
        }],
        subTotal: 123_456,
        tax: 9_877,
        grandTotal: 132_833,
        fees: [{ label: 'Shipping', cents: 0, text: 'Free' }],
        singleFee: true,
        discounts: [{ label: 'Savings', cents: -500 }],
        refunds: [{ label: 'Refund', cents: -100 }],
        payments: [
          { type: 'CREDITCARD', cardType: 'AMEX', last4: SYNTHETIC_WALMART_CARD, charged: [122_833] },
          { type: 'GIFTCARD', cardType: null, last4: SYNTHETIC_WALMART_GIFT_CARD, charged: [10_000] },
        ],
        refundPayments: [{ type: 'CREDITCARD', cardType: 'AMEX', last4: SYNTHETIC_WALMART_CARD, amounts: [100] }],
        chargeHistoryEntries: 2,
        flags: { refunded: true },
      },
      {
        seed: 2,
        orderDateRaw: '2025-04-11T13:30:00.000-04:00',
        orderAt: '2025-04-11T17:30:00.000Z',
        groupsKey: 'groups',
        groups: [{
          fulfillmentType: 'SC_PICKUP',
          detailedGroupType: 'PICKUP_CURBSIDE',
          derivedKey: true,
          status: 'PICKED_UP',
          statusParts: ['Picked up ', 'Apr 12'],
          eventDate: '2025-04-12',
          readyForPickupDate: '2025-04-12',
          store: SYNTHETIC_WALMART_STORE,
          seller: null,
          items: [{ line: 1, name: 'SAMPLE SNACK', qty: 3, lineCents: 897 }],
        }],
        subTotal: 897,
        tax: 0,
        grandTotal: 907,
        orderTotalKey: true,
        fees: [{ label: 'Bag fee', cents: 10 }],
        payments: [{ type: 'PAYPAL', cardType: 'PAYPAL', last4: null, charged: [907] }],
      },
      {
        seed: 3,
        orderDateRaw: '2025-07-01T12:00:00.000-07:00',
        orderAt: '2025-07-01T19:00:00.000Z',
        groupsKey: 'groups_2200',
        groups: [{
          fulfillmentType: 'SC_DELIVERY',
          detailedGroupType: 'DFS',
          status: 'CANCELED',
          statusParts: ['Canceled'],
          seller: { id: 0, name: SYNTHETIC_WALMART_SELLER, isPro: false, shown: false, shippedByWalmart: true },
          items: [{ line: 1, name: 'SAMPLE PATIO SET', qty: 1, lineCents: null }],
        }],
        subTotal: 0,
        tax: 0,
        grandTotal: 0,
        driverTip: 300,
        grandTotalWithTips: 300,
        donations: [{ label: 'SAMPLE ROUND UP', cents: 42 }],
        payments: [{ type: 'CREDITCARD', cardType: 'VISA', last4: SYNTHETIC_WALMART_CARD, charged: [] }],
        flags: { cancelled: true },
      },
    ],
  };
}

/** Every invented value of `syntheticWalmartSpec` that must never appear in an issue. */
export function syntheticWalmartSensitiveValues(): string[] {
  return [
    syntheticWalmartOrderId(1), syntheticWalmartOrderId(2), syntheticWalmartOrderId(3),
    syntheticWalmartDisplayId(1), syntheticWalmartDisplayId(2), syntheticWalmartDisplayId(3),
    SYNTHETIC_WALMART_CARD, SYNTHETIC_WALMART_GIFT_CARD, SYNTHETIC_WALMART_TRACKING,
    SYNTHETIC_WALMART_SELLER, SYNTHETIC_WALMART_SELLER_ID, SYNTHETIC_WALMART_STORE,
    'SAMPLE WIDGET', 'TESTNAME GADGET', 'SAMPLE SNACK', 'SAMPLE PATIO SET', 'SAMPLE ROUND UP',
    'SAMPLE ORDER TITLE', 'SAMPLE CHARGE', 'SAMPLE PAYMENT MESSAGE', 'SAMPLE DELIVERY MESSAGE', 'SAMPLE-TRACKING',
    'SAMPLEOFFER', 'Ending in', 'SAMPLE PARSE', 'Delivered on', 'Picked up',
    '$1,234.56', '1,234.56', '1234.56', '123456', '98.77', '1,328.33', '1,228.33',
  ];
}

/** What `syntheticWalmartSensitiveValues` lists, under the name every capture fixture uses. */
export const syntheticSensitiveValues = syntheticWalmartSensitiveValues;
