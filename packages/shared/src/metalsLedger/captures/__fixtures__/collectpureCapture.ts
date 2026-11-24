/**
 * Synthetic CollectPure captures for tests: the pull's `holdr-retail-capture/collectpure@1` consolidated file and its raw
 * files (`sell-order-<id>.json`, `payout-history-pNN.json`, the stats files), built from one compact spec with the field
 * names and vocabularies the real capture uses, so they agree the way the capture's own normalizer makes them agree.
 * Every value is invented: sell-order, line and payout ids, products, amounts, bank and account endings, confirmation
 * numbers. None comes from a household capture.
 *
 * Amounts in specs are integer cents, as CollectPure's API states them. Pages show them as text ('$1,234.56'). New York
 * dates come from the platform's own time-zone data (Intl), as the capture's normalizer and the payload's
 * metalsNewYorkDate take them. A real capture's timeline always lists all seven steps, each dated; a synthetic
 * in-progress sale may list fewer.
 */

export const SYNTHETIC_COLLECTPURE_CAPTURED_AT = '2026-01-02T03:04:05.000Z';
export const SYNTHETIC_COLLECTPURE_ACCOUNT = '0007';
export const SYNTHETIC_COLLECTPURE_BANK = 'SAMPLE BANK';
export const SYNTHETIC_COLLECTPURE_CONFIRMATION = 'SAMPLECONF';

/** A synthetic sell-order id. */
export const syntheticSellOrderId = (seed: number) => `SO7${String(seed).padStart(7, '0')}`;
/** A synthetic payout id. */
export const syntheticPayoutId = (seed: number, index: number) => `PAYOUT${String(seed).padStart(4, '0')}X${index}`;
/**
 * A status in the page's words, as a raw sell order states it (`order.status`) and the consolidated record keeps it
 * (`status.detailStatus`): "Order Complete", never the key. Only that one is seen in real captures; the rest are synthetic.
 */
export const syntheticCollectPureStatusText = (key: string) =>
  key.split('_').map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');

/** Cents as CollectPure's pages show them: '$1,234.56', '-$15.00'. */
export function syntheticCollectPureMoneyText(cents: number): string {
  const whole = String(Math.floor(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}$${whole}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
}

const NEW_YORK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
/** An instant's New York calendar date, by the platform's time-zone data, assembled from parts (never a locale's format). */
export function intlNewYorkDate(at: string): string {
  const parts = Object.fromEntries(NEW_YORK.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export interface SyntheticCollectPureLine {
  id: number;
  /** Null: the line states no SKU. */
  sku: string | null;
  name: string;
  program: string | null;
  premium: 'troy_ounce' | 'unit' | null;
  qty: number;
  /** Cents per unit. */
  price: number;
  /** The API states the price as numeric text ('123456.0') rather than a number. */
  priceAsText?: boolean;
  spotPremium?: string | number | null;
  spotPremiumDollar?: number | null;
  status: 'Item Complete' | 'Item Pending' | null;
  inspection?: { received: boolean; passed: boolean; buyerPaid: boolean } | null;
}

export interface SyntheticCollectPurePayout {
  amount: number;
  /** The capture's vocabulary: 'complete'. */
  status: string;
  /** The payout's calendar date, `YYYY-MM-DD`. */
  date: string;
  /** When it was created, an ISO UTC instant; by default noon UTC of its date. */
  createdAt?: string;
}

export interface SyntheticCollectPureSellOrder {
  seed: number;
  /** The status key. */
  status: string;
  /** An ISO UTC instant. */
  placedAt: string;
  completeAt?: string | null;
  /** Each step's ISO UTC instant; the raw file states it with microseconds and an offset. */
  timeline: Array<{ status: string; at: string | null }>;
  lines: SyntheticCollectPureLine[];
  /** The two deductions in cents, signed as the site states them: zero or negative. */
  shipping?: number | null;
  processingFee?: number | null;
  salesTax?: number | null;
  /** Real sales state one, restating the platform fee in the same negative cents: never counted in the total. */
  optionalFees?: Array<{ title: string; fee: number }>;
  breakdown: Array<{ label: string; cents: number }>;
  payouts?: SyntheticCollectPurePayout[];
  shipment?: { carrier: string; deliveredAt: string | null } | null;
  /** Whether the page states a price lock: false in every real capture. */
  priceLockStated?: boolean;
}

export interface SyntheticCollectPureSpec {
  schema?: string;
  sellOrders: SyntheticCollectPureSellOrder[];
  /** The 11/08 snapshot's raw-file form: capturedAt, status and source beside `result`. */
  snapshot?: boolean;
  /** How many payouts a payout-history page holds (default 20). */
  payoutPageSize?: number;
}

export interface SyntheticCollectPureRawFile {
  name: string;
  json: Record<string, unknown>;
}

export interface SyntheticCollectPureCapture {
  consolidated: Record<string, unknown>;
  rawSellOrders: Array<SyntheticCollectPureRawFile & { id: string }>;
  /** `payout-history-p01.json`, … in order; the last page's cursor is null. */
  payoutHistoryPages: SyntheticCollectPureRawFile[];
  /** `sell-stats.json`, `buy-stats.json` and `inventory-stats.json`. */
  stats: SyntheticCollectPureRawFile[];
}

/** The API's money as the capture writes it. */
const apiMoney = (cents: number, raw: number | string = cents) => ({ cents, currency: 'USD', raw, rawUnit: 'cents' });
/** The page's money as the capture writes it. */
const pageMoney = (cents: number) => ({ cents, currency: 'USD', raw: syntheticCollectPureMoneyText(cents) });
const optionalApiMoney = (cents: number | null | undefined) => (cents === null || cents === undefined ? null : apiMoney(cents));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
/** The same instant, as the API writes it: microseconds and a numeric offset. */
const apiStamp = (at: string) => at.replace(/Z$/, '456+00:00');
/** A calendar date as the pages show it: M/D/YYYY. */
const pageDate = (day: string) => {
  const [year, month, date] = day.split('-');
  return `${Number(month)}/${Number(date)}/${year}`;
};
const createdAtOf = (payout: SyntheticCollectPurePayout) => payout.createdAt ?? `${payout.date}T12:00:00.000Z`;

function buildSellOrder(spec: SyntheticCollectPureSellOrder) {
  const id = syntheticSellOrderId(spec.seed);
  const optionalFees = spec.optionalFees ?? [];
  const subtotal = sum(spec.lines.map((line) => line.price * line.qty));
  // Both deductions are stated signed (zero or negative) and count once; an optional fee restates the platform fee.
  const total = subtotal + (spec.shipping ?? 0) + (spec.processingFee ?? 0);
  const payouts = (spec.payouts ?? []).map((payout, index) => ({
    ...payout,
    id: syntheticPayoutId(spec.seed, index),
    confirmationNumber: `${SYNTHETIC_COLLECTPURE_CONFIRMATION}${spec.seed}${index}`,
  }));
  const rawPrice = (line: SyntheticCollectPureLine) => (line.priceAsText === true ? `${line.price}.0` : line.price);
  const raw = {
    order: {
      id,
      status: syntheticCollectPureStatusText(spec.status),
      createdAt: spec.placedAt,
      lineItems: spec.lines.map((line) => ({
        id: line.id,
        quantity: line.qty,
        price: rawPrice(line),
        product: { sku: line.sku, title: line.name, premiumCalculationType: line.premium },
        variant: line.program === null ? null : { title: line.program },
        spotPremium: line.spotPremium ?? null,
        spotPremiumDollar: line.spotPremiumDollar ?? null,
        status: line.status,
        tracking: line.inspection
          ? {
            recievedForInspection: line.inspection.received,
            passedInspection: line.inspection.passed,
            inspectionNotes: 'SAMPLE INSPECTION NOTE',
            buyerPaid: line.inspection.buyerPaid,
          }
          : null,
      })),
      subtotal,
      shipping: spec.shipping ?? null,
      processingFee: spec.processingFee ?? null,
      salesTax: spec.salesTax ?? null,
      total,
      currency: 'USD',
      selectedOptionals: optionalFees.map((fee) => ({ title: fee.title, fee: fee.fee })),
      appliedPromotions: [],
      instantPayoutAdvance: null,
      statusHistory: spec.timeline.map((step) => ({ status: step.status, changed_at: step.at === null ? null : apiStamp(step.at) })),
      payoutDetails: { method: 'ach', ach: { last4: SYNTHETIC_COLLECTPURE_ACCOUNT, bankName: SYNTHETIC_COLLECTPURE_BANK } },
      payoutTransactions: payouts.map((payout) => ({
        id: payout.id, amount: payout.amount, method: 'ACH', status: payout.status, confirmationNumber: payout.confirmationNumber,
      })),
    },
    page: {
      breakdown: spec.breakdown.flatMap((row) => [row.label, syntheticCollectPureMoneyText(row.cents)]),
      badge: 'SAMPLE BADGE',
    },
    capturedAt: SYNTHETIC_COLLECTPURE_CAPTURED_AT,
  };
  const deliveredAt = spec.shipment?.deliveredAt ?? null;
  const placedDateNY = intlNewYorkDate(spec.placedAt);
  const consolidated = {
    id,
    purchaseOrderLabel: `PO ${id}`,
    placedAt: spec.placedAt,
    placedDateNY,
    // The page's order date is the UTC calendar date, which differs from the New York date on evening placements.
    orderDate: pageDate(spec.placedAt.slice(0, 10)),
    shipByDate: placedDateNY,
    completeAt: spec.completeAt ?? null,
    createdAt: spec.placedAt,
    status: { key: spec.status, label: 'SAMPLE STATUS LABEL', pageBadge: 'SAMPLE BADGE', detailStatus: syntheticCollectPureStatusText(spec.status) },
    timeline: spec.timeline.map((step) => ({
      status: step.status,
      pageLabel: 'SAMPLE STEP',
      at: step.at,
      dateNY: step.at === null ? null : intlNewYorkDate(step.at),
      pageDate: step.at === null ? null : pageDate(intlNewYorkDate(step.at)),
    })),
    lines: spec.lines.map((line) => ({
      lineItemId: line.id,
      sku: line.sku,
      name: line.name,
      program: line.program,
      premiumCalculationType: line.premium,
      // The capture's own readings, which Holdr never reads: deliberately set, so a test can see them dropped.
      metal: 'SAMPLE-CODE',
      weightOztPerUnit: 1,
      weightParsedFrom: 'SAMPLE PARSE',
      qty: line.qty,
      unitPrice: apiMoney(line.price, rawPrice(line)),
      lineTotal: apiMoney(line.price * line.qty),
      spotPremiumRaw: line.spotPremium ?? null,
      spotPremiumDollar: optionalApiMoney(line.spotPremiumDollar),
      status: line.status,
      inspection: line.inspection
        ? {
          receivedForInspection: line.inspection.received,
          passedInspection: line.inspection.passed,
          inspectionNotes: 'SAMPLE INSPECTION NOTE',
          buyerPaid: line.inspection.buyerPaid,
        }
        : null,
    })),
    listProducts: spec.lines.map((line) => ({ sku: line.sku, name: line.name, variant: line.program, qty: line.qty, price: pageMoney(line.price) })),
    amounts: {
      subtotal: apiMoney(subtotal),
      shipping: optionalApiMoney(spec.shipping),
      processingFee: optionalApiMoney(spec.processingFee),
      salesTax: optionalApiMoney(spec.salesTax),
      total: apiMoney(total),
      currency: 'USD',
      optionalFees: optionalFees.map((fee) => ({ title: fee.title, fee: apiMoney(fee.fee) })),
      appliedPromotions: 0,
      instantPayoutAdvance: null,
    },
    pageBreakdown: spec.breakdown.map((row) => ({ label: row.label, amount: pageMoney(row.cents) })),
    payout: {
      method: 'ach',
      destinationLast4: SYNTHETIC_COLLECTPURE_ACCOUNT,
      pageMethodLines: [`${SYNTHETIC_COLLECTPURE_BANK} ending ${SYNTHETIC_COLLECTPURE_ACCOUNT}`],
      transactions: payouts.map((payout) => ({
        payoutId: payout.id,
        amount: apiMoney(payout.amount),
        method: 'ACH',
        status: payout.status,
        confirmationNumber: payout.confirmationNumber,
        initiatedAt: createdAtOf(payout),
        payoutDate: payout.date,
        payoutDateRaw: payout.date,
      })),
      totalPaid: { cents: sum(payouts.map((payout) => payout.amount)), currency: 'USD', raw: 'sum of payoutTransactions' },
    },
    shipments: spec.shipment
      ? [{
        carrier: spec.shipment.carrier,
        status: deliveredAt === null ? 'In Transit' : 'Delivered',
        delivered: deliveredAt !== null,
        labelCreatedAt: spec.placedAt,
        shippedAt: spec.placedAt,
        deliveredAt,
        deliveredDateLocal: deliveredAt === null ? null : intlNewYorkDate(deliveredAt),
        estDeliveryDate: 'SAMPLE ESTIMATE',
      }]
      : [],
    priceLock: { statedOnPage: spec.priceLockStated ?? false, pageText: ['SAMPLE PRICE LOCK TEXT'] },
    combinedSellOrderIds: [],
    detailCaptured: true,
    detailCapturedAt: SYNTHETIC_COLLECTPURE_CAPTURED_AT,
  };
  const listedPayouts = payouts.map((payout) => ({
    payoutId: payout.id,
    sellOrderId: id,
    amount: apiMoney(payout.amount),
    method: 'ACH',
    status: payout.status,
    confirmationNumber: payout.confirmationNumber,
    payoutDate: payout.date,
    payoutDateRaw: payout.date,
    initiatedAt: createdAtOf(payout),
  }));
  const historyItems = payouts.map((payout) => ({
    id: payout.id,
    orderId: id,
    amount: payout.amount,
    method: 'ACH',
    status: payout.status,
    confirmationNumber: payout.confirmationNumber,
    payoutDate: payout.date,
    createdAt: createdAtOf(payout),
  }));
  return { id, raw, consolidated, listedPayouts, historyItems };
}

/** A raw API response as the pull saved it: the base's form, or the snapshot's with capturedAt, status and source. */
function apiFile(json: Record<string, unknown>, snapshot: boolean, meta?: Record<string, unknown>): Record<string, unknown> {
  const result = { data: meta === undefined ? { json } : { json, meta } };
  return snapshot ? { capturedAt: SYNTHETIC_COLLECTPURE_CAPTURED_AT, status: 200, source: 'collectpure.com', result } : { result };
}

const pageName = (index: number) => `payout-history-p${String(index + 1).padStart(2, '0')}.json`;

/** A whole synthetic CollectPure capture: the consolidated file and its raw files. */
export function syntheticCollectPureCapture(spec: SyntheticCollectPureSpec): SyntheticCollectPureCapture {
  const snapshot = spec.snapshot === true;
  const orders = spec.sellOrders.map(buildSellOrder);
  const count = orders.length;
  const completed = spec.sellOrders.filter((order) => order.status === 'order_complete').length;
  const cancelled = spec.sellOrders.filter((order) => order.status === 'cancelled').length;
  const statsCounts = { total: count, active: count - completed - cancelled, completed, cancelled };
  const historyItems = orders.flatMap((order) => order.historyItems);
  const pageSize = spec.payoutPageSize ?? 20;
  const pageCount = Math.max(1, Math.ceil(historyItems.length / pageSize));
  const payoutHistoryPages = Array.from({ length: pageCount }, (_, index) => {
    const last = index === pageCount - 1;
    const page = { items: historyItems.slice(index * pageSize, (index + 1) * pageSize), nextCursor: last ? null : 9_000 + index };
    const meta = snapshot ? undefined : { values: { nextCursor: ['undefined'] } };
    return { name: pageName(index), json: apiFile(page, snapshot, meta) };
  });
  const zeroValues = { totalValue: 0, activeValue: 0, completedValue: 0, cancelledValue: 0 };
  return {
    consolidated: {
      schema: spec.schema ?? 'holdr-retail-capture/collectpure@1',
      provenance: {
        source: 'collectpure.com',
        // Only a snapshot names its folder and the details it reused: a base capture states neither key.
        ...(snapshot ? { snapshotFolder: 'synthetic-snapshot', detailsReusedFromOct24Capture: 0 } : {}),
        capturedBy: 'synthetic',
        capturedAt: SYNTHETIC_COLLECTPURE_CAPTURED_AT,
        currency: 'USD',
        dateNote: 'synthetic',
        pages: [
          {
            path: '/dashboard/sell-orders', how: 'synthetic, 50 per page',
            selector: { type: 'sell', query: 'synthetic', shippingLabel: false, limit: 50, offsets: [0] },
            rowsSeen: count, statedTotal: count, statsCounts,
          },
          { path: '/order/sell/<id>', how: 'synthetic', detailPagesCaptured: count, of: count, omitted: 0 },
          { path: '/dashboard/payouts', how: 'synthetic', pages: pageCount, rowsSeen: historyItems.length, statedTotal: null },
          { path: '/dashboard/payments', how: '' },
          { path: '/dashboard/buy-orders', how: '', statedTotal: 0, rowsSeen: 0 },
          { path: '/dashboard/inventory', how: '', statedTotal: 0, rowsSeen: 0 },
          { path: '/dashboard/vault', how: '', state: 'waitlist' },
          { path: '/dashboard/listings', how: '', countsOnly: true },
        ],
        checks: {
          sellOrdersListed: count, payoutsListed: sum(orders.map((order) => order.listedPayouts.length)), pageTotalEqualsApiTotal: 1,
          pageTotalDiffers: 0,
        },
      },
      sellOrders: orders.map((order) => order.consolidated),
      payouts: orders.flatMap((order) => order.listedPayouts),
      payoutMethod: { bankName: SYNTHETIC_COLLECTPURE_BANK, last4: SYNTHETIC_COLLECTPURE_ACCOUNT },
      paymentMethods: [],
      buyOrders: { statedTotal: 0, rows: 0, statsCounts: { total: 0, active: 0, completed: 0, cancelled: 0 } },
      inventory: { statedTotal: 0, rows: 0, totalCount: 0, listedCount: 0, unlistedCount: 0 },
      vault: { enabled: false, state: 'waitlist' },
      listings: [],
      offers: [],
      developers: null,
    },
    rawSellOrders: orders.map((order) => ({ name: `sell-order-${order.id}.json`, id: order.id, json: order.raw })),
    payoutHistoryPages,
    stats: [
      { name: 'sell-stats.json', json: apiFile({ ...statsCounts, ...zeroValues }, snapshot) },
      { name: 'buy-stats.json', json: apiFile({ total: 0, active: 0, completed: 0, cancelled: 0, ...zeroValues }, snapshot) },
      {
        name: 'inventory-stats.json',
        json: apiFile({ totalValue: 0, totalCount: 0, listedCount: 0, unlistedCount: 0, totalSpent: 0, totalProfitDollar: 0, totalProfitPercent: 0 }, snapshot),
      },
    ],
  };
}

/**
 * Two sell orders: a complete one with a priced-by-weight line stated as numeric text, a per-unit line, its deductions
 * signed as the site states them, an optional fee restating its platform fee, a full timeline, a payout and a delivered
 * shipment; and one in transit, with a pending line, no fees, a step not yet reached and no payout.
 */
export function syntheticCollectPureSpec(): SyntheticCollectPureSpec {
  return {
    sellOrders: [
      {
        seed: 1,
        status: 'order_complete',
        placedAt: '2025-10-01T12:00:00.123Z',
        completeAt: '2025-10-08T18:30:00.000Z',
        timeline: [
          { status: 'pending_confirmation', at: '2025-10-01T12:00:00.123Z' },
          { status: 'ready_for_shipment', at: '2025-10-01T12:05:00.000Z' },
          { status: 'in_transit', at: '2025-10-02T09:00:00.000Z' },
          { status: 'items_received', at: '2025-10-06T15:00:00.000Z' },
          { status: 'check_in_progress', at: '2025-10-07T10:00:00.000Z' },
          { status: 'check_in_complete', at: '2025-10-07T16:00:00.000Z' },
          { status: 'order_complete', at: '2025-10-08T18:30:00.000Z' },
        ],
        lines: [
          {
            id: 5001, sku: 'SAMPLE-SKU-1', name: 'SAMPLE ITEM ONE', program: 'SAMPLE PROGRAM', premium: 'troy_ounce', qty: 2,
            price: 123_456, priceAsText: true, spotPremium: '2.5', spotPremiumDollar: 3_086, status: 'Item Complete',
            inspection: { received: true, passed: true, buyerPaid: true },
          },
          {
            id: 5002, sku: 'SAMPLE-SKU-2', name: 'TESTNAME ITEM TWO', program: null, premium: 'unit', qty: 1, price: 4_200,
            spotPremium: 1.25, status: 'Item Complete', inspection: null,
          },
        ],
        shipping: -3_000,
        processingFee: -2_511,
        optionalFees: [{ title: 'SAMPLE INSURANCE', fee: -2_511 }],
        breakdown: [
          { label: 'Subtotal', cents: 251_112 },
          { label: 'Insured Shipping', cents: -3_000 },
          { label: 'Platform Fee (1%)', cents: -2_511 },
          { label: 'Total Payout', cents: 245_601 },
        ],
        payouts: [{ amount: 245_601, status: 'complete', date: '2025-10-09' }],
        shipment: { carrier: 'SAMPLE CARRIER', deliveredAt: '2025-10-06T14:00:00.000Z' },
      },
      {
        seed: 2,
        status: 'in_transit',
        placedAt: '2025-11-01T08:00:00.000Z',
        timeline: [
          { status: 'pending_confirmation', at: '2025-11-01T08:00:00.000Z' },
          { status: 'ready_for_shipment', at: '2025-11-01T08:30:00.000Z' },
          { status: 'in_transit', at: null },
        ],
        lines: [{
          id: 5003, sku: 'SAMPLE-SKU-3', name: 'SAMPLE COLLECTIBLE', program: null, premium: null, qty: 3, price: 999,
          status: 'Item Pending', inspection: null,
        }],
        breakdown: [
          { label: 'Subtotal', cents: 2_997 },
          { label: 'Total Payout', cents: 2_997 },
        ],
        shipment: { carrier: 'SAMPLE CARRIER', deliveredAt: null },
      },
    ],
  };
}

/** Every invented value of `syntheticCollectPureSpec` that must never appear in an issue. */
export function syntheticCollectPureSensitiveValues(): string[] {
  return [
    syntheticSellOrderId(1), syntheticSellOrderId(2), syntheticPayoutId(1, 0),
    SYNTHETIC_COLLECTPURE_ACCOUNT, SYNTHETIC_COLLECTPURE_BANK, SYNTHETIC_COLLECTPURE_CONFIRMATION,
    'SAMPLE ITEM ONE', 'TESTNAME ITEM TWO', 'SAMPLE COLLECTIBLE', 'SAMPLE-SKU', 'SAMPLE PROGRAM', 'SAMPLE INSURANCE',
    'SAMPLE INSPECTION NOTE', 'SAMPLE PRICE LOCK TEXT', 'SAMPLE STATUS LABEL', 'SAMPLE BADGE', 'SAMPLE CARRIER', 'SAMPLE PARSE',
    '$2,511.12', '2,511.12', '2511.12', '251112', '123456', '2,456.01', '245601',
  ];
}

/** What `syntheticCollectPureSensitiveValues` lists, under the name every capture fixture uses. */
export const syntheticSensitiveValues = syntheticCollectPureSensitiveValues;
