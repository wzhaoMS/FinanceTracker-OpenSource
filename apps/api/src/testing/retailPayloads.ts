import {
  COSTCO_CAPTURE_SCHEMA,
  RETAIL_CONVERT_POLICY_VERSION,
  RETAIL_IMPORT_FORMAT,
  RETAIL_IMPORT_VERSION,
  RETAIL_METAL_GUARD,
  RETAIL_METAL_TITLE_RULE,
  retailLineKey,
  retailNaturalKey,
  serializeRetailImportPayload,
  validateRetailImportPayload,
  type RetailHeldRecord,
  type RetailImportLine,
  type RetailImportPayload,
  type RetailImportReceipt,
  type RetailImportTender,
  type RetailShipment,
} from '@finance-tracker/shared/retail-import-payload';

/**
 * Invented retail payloads (`holdr.retail-import` format 3, policy 5) for the retail domain's tests (Costco PR 2). Every
 * value is made up here: keys come from made-up native ids, titles, amounts, card endings and membership facts are
 * synthetic, and no capture is read. Each builder returns a payload the shared validator accepts (`syntheticRetailPayload`
 * checks it), so a test that changes one field changes only what it means to.
 */

export const SYNTHETIC_RETAIL = Object.freeze({
  capturedAt: '2031-02-03T04:05:06Z',
  converter: 'holdr-retail-convert 1.4.0',
  // The converter fixtures' own synthetic endings (costcoCapture.ts), so no new four-digit value enters the tree.
  card: '0007',
  card2: '0011',
  memberLast4: '0042',
  memberSinceYear: '2003',
  tier: 'Executive',
  widget: 'SAMPLE WIDGET',
  gadget: 'SAMPLE GADGET',
  bar: 'SAMPLE BULLION BAR',
});

/** A warehouse receipt's natural key, from a made-up barcode. */
export const warehouseKey = (seed: number | string): string => retailNaturalKey('costco', 'receipt', `SAMPLE-W-${seed}`);
/** An online order's natural key, from a made-up order number. */
export const orderKey = (seed: number | string): string => retailNaturalKey('costco', 'order', `SAMPLE-O-${seed}`);
export const lineKey = (order: number | string, line: number): string => retailLineKey('costco', `SAMPLE-O-${order}`, `SAMPLE-L-${line}`);

/** A plain warehouse item line. */
export function warehouseLine(ordinal: number, amountMinor: number, patch: Partial<RetailImportLine> = {}): RetailImportLine {
  return {
    ordinal, lineKey: null, kind: 'item', itemNumber: String(100100 + ordinal), title: SYNTHETIC_RETAIL.widget, title2: null, department: 12,
    quantity: 1, unitPriceMinor: amountMinor, amountMinor, shippingMinor: null, taxFlag: 'Y', couponTarget: null, feeParent: null, fulfilment: null,
    metal: null, metalUncertain: null, storedValue: null, fuelGallons: null, fuelUnitPrice: null, events: null, shipments: [], ...patch,
  };
}

/** A warehouse receipt: its lines, tax and card tenders, with the money identities the validator re-checks. */
export function warehouseReceipt(seed: number | string, options: {
  lines?: RetailImportLine[]; taxMinor?: number; tenders?: Array<Omit<RetailImportTender, 'ordinal'>>; date?: string; localTime?: string | null;
  taxLegends?: RetailImportReceipt['taxLegends']; instantSavingsMinor?: number | null;
} = {}): RetailImportReceipt {
  const lines = options.lines ?? [warehouseLine(0, 1_000)];
  const subtotal = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const tax = options.taxMinor ?? 80;
  const total = subtotal + tax;
  const tenders = (options.tenders ?? [{ kind: 'card', network: 'visa', last4: SYNTHETIC_RETAIL.card, amountMinor: total }])
    .map((tender, ordinal) => ({ ordinal, ...tender }));
  return {
    channel: 'warehouse', naturalKey: warehouseKey(seed), date: options.date ?? '2031-01-10', localTime: options.localTime === undefined ? '10:15' : options.localTime,
    sign: total > 0 ? 'sale' : 'refund', status: null, currency: 'USD',
    totals: { subtotalMinor: subtotal, taxMinor: tax, instantSavingsMinor: options.instantSavingsMinor ?? null, discountMinor: null, shippingMinor: null,
      feesMinor: null, storedValueMinor: null, totalMinor: total },
    taxLegends: options.taxLegends ?? [], lines, tenders,
  };
}

/** An online order line, with its events and shipments. */
export function onlineLine(order: number | string, ordinal: number, amountMinor: number, patch: Partial<RetailImportLine> = {}): RetailImportLine {
  return {
    ordinal, lineKey: lineKey(order, ordinal), kind: 'item', itemNumber: String(200200 + ordinal), title: SYNTHETIC_RETAIL.gadget, title2: null,
    department: null, quantity: 1, unitPriceMinor: amountMinor, amountMinor, shippingMinor: 0, taxFlag: null, couponTarget: null, feeParent: null,
    fulfilment: 'parcel', metal: null, metalUncertain: null, storedValue: null, fuelGallons: null, fuelUnitPrice: null,
    events: { shipped: [{ quantity: 1, date: '2031-01-12' }], delivered: [], cancelled: [], returned: [] },
    shipments: [{ shippedDate: '2031-01-12', deliveredDate: null, estimatedArrivalDate: '2031-01-15', carrier: 'ups' }], ...patch,
  };
}

export const shipment = (patch: Partial<RetailShipment> = {}): RetailShipment =>
  ({ shippedDate: '2031-01-12', deliveredDate: null, estimatedArrivalDate: '2031-01-15', carrier: 'ups', ...patch });

/** An online order: its lines, tax and one card payment of the total (plus any Shop Card payments of `storedValueMinor`). */
export function onlineOrder(seed: number | string, options: {
  lines?: RetailImportLine[]; taxMinor?: number; status?: RetailImportReceipt['status']; date?: string; shopCards?: number[]; card?: string;
} = {}): RetailImportReceipt {
  const lines = options.lines ?? [onlineLine(seed, 0, 5_000)];
  const subtotal = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const shipping = lines.reduce((sum, line) => sum + (line.shippingMinor ?? 0), 0);
  const tax = options.taxMinor ?? 400;
  const stored = (options.shopCards ?? []).reduce((sum, amount) => sum + amount, 0);
  const total = subtotal + shipping + tax - stored;
  const tenders: RetailImportTender[] = [
    ...(total > 0 ? [{ ordinal: 0, kind: 'card' as const, network: 'visa' as const, last4: options.card ?? SYNTHETIC_RETAIL.card, amountMinor: total }] : []),
    ...(options.shopCards ?? []).map((amountMinor) => ({ ordinal: 0, kind: 'shop-card' as const, network: 'unknown' as const, last4: null, amountMinor })),
  ].map((tender, ordinal) => ({ ...tender, ordinal }));
  return {
    channel: 'online', naturalKey: orderKey(seed), date: options.date ?? '2031-01-11', localTime: null, sign: 'sale', status: options.status ?? 'shipped',
    currency: 'USD',
    totals: { subtotalMinor: subtotal, taxMinor: tax, instantSavingsMinor: null, discountMinor: 0, shippingMinor: shipping, feesMinor: 0,
      storedValueMinor: stored, totalMinor: total },
    taxLegends: [], lines, tenders,
  };
}

/** A metal line's facts (title rule v3, pack rule v2): on an item line only. */
export const goldBar = (patch: Partial<NonNullable<RetailImportLine['metal']>> = {}): NonNullable<RetailImportLine['metal']> =>
  ({ metal: 'XAU', form: 'bar', statedWeight: { value: '1', unit: 'ozt' }, rule: RETAIL_METAL_TITLE_RULE, pack: 'single', ...patch });
/** Metal guard v1's flag on a line that is no metal. */
export const uncertainGold = (): NonNullable<RetailImportLine['metalUncertain']> =>
  ({ guard: RETAIL_METAL_GUARD, evidence: ['bullion-word'], metal: 'XAU' });

/** A gas station receipt's natural key, from a made-up barcode. */
export const gasKey = (seed: number | string): string => retailNaturalKey('costco', 'receipt', `SAMPLE-G-${seed}`);

/** A warehouse coupon line against the line at `target` (null: the receipt's own discount): a negative amount, no title. */
export function couponLine(ordinal: number, target: number | null, amountMinor: number, patch: Partial<RetailImportLine> = {}): RetailImportLine {
  return warehouseLine(ordinal, amountMinor, {
    kind: 'coupon', itemNumber: String(300300 + ordinal), title: null, department: null, quantity: null, unitPriceMinor: null, taxFlag: null,
    couponTarget: target, ...patch,
  });
}

/** A fuel line: its gallons and price per gallon as the receipt states them, and no unit price in cents. */
export function fuelLine(ordinal: number, amountMinor: number, patch: Partial<RetailImportLine> = {}): RetailImportLine {
  return warehouseLine(ordinal, amountMinor, {
    kind: 'fuel', itemNumber: String(400400 + ordinal), title: 'SAMPLE FUEL', department: null, quantity: null, unitPriceMinor: null, taxFlag: null,
    fuelGallons: '12.345', fuelUnitPrice: '3.459', ...patch,
  });
}

/** A gas station receipt: a fuel line, no tax, paid by card. */
export function gasReceipt(seed: number | string, options: {
  lines?: RetailImportLine[]; tenders?: Array<Omit<RetailImportTender, 'ordinal'>>; date?: string; localTime?: string | null;
} = {}): RetailImportReceipt {
  const receipt = warehouseReceipt(seed, {
    lines: options.lines ?? [fuelLine(0, 4_270)], taxMinor: 0, tenders: options.tenders, date: options.date,
    localTime: options.localTime === undefined ? '07:30' : options.localTime,
  });
  return { ...receipt, channel: 'gas', naturalKey: gasKey(seed) };
}

/** A warehouse refund: its lines returned (negative quantity and amount), the tax given back, refunded to the card. */
export function warehouseRefund(seed: number | string, options: { lines?: RetailImportLine[]; taxMinor?: number; date?: string } = {}): RetailImportReceipt {
  const lines = options.lines ?? [warehouseLine(0, -1_000, { quantity: -1, unitPriceMinor: 1_000 })];
  const tax = options.taxMinor ?? -80;
  const total = lines.reduce((sum, line) => sum + line.amountMinor, 0) + tax;
  return warehouseReceipt(seed, {
    lines, taxMinor: tax, date: options.date, tenders: [{ kind: 'card-refund', network: 'visa', last4: SYNTHETIC_RETAIL.card, amountMinor: total }],
  });
}

export const heldRecord = (patch: Partial<RetailHeldRecord> = {}): RetailHeldRecord =>
  ({ channel: 'warehouse', naturalKey: warehouseKey('held'), reason: 'capture-disagreement', check: 'record-totals', date: '2031-01-09', ...patch });

export interface SyntheticPayloadOptions {
  folder?: string;
  receipts?: RetailImportReceipt[];
  held?: RetailHeldRecord[];
  memberSinceYear?: string | null;
  membershipLast4?: string | null;
  tier?: string | null;
  /** One letter a–p: the capture digest is 64 of it, so payloads of different captures differ. */
  capture?: string;
  capturedAt?: string;
}

/** A whole payload of one membership; refused here if the shared validator would refuse it (a broken fixture, not a test). */
export function syntheticRetailPayload(options: SyntheticPayloadOptions = {}): RetailImportPayload {
  const payload: RetailImportPayload = {
    format: RETAIL_IMPORT_FORMAT, version: RETAIL_IMPORT_VERSION, merchant: 'costco', converterVersion: SYNTHETIC_RETAIL.converter,
    policyVersion: RETAIL_CONVERT_POLICY_VERSION,
    source: { schema: COSTCO_CAPTURE_SCHEMA, captureDigest: (options.capture ?? 'b').repeat(64), capturedAt: options.capturedAt ?? SYNTHETIC_RETAIL.capturedAt,
      files: 3 },
    membership: {
      folder: options.folder ?? 'costco',
      memberSinceYear: options.memberSinceYear === undefined ? SYNTHETIC_RETAIL.memberSinceYear : options.memberSinceYear,
      tier: options.tier === undefined ? SYNTHETIC_RETAIL.tier : options.tier,
      membershipLast4: options.membershipLast4 === undefined ? SYNTHETIC_RETAIL.memberLast4 : options.membershipLast4,
    },
    coverage: {
      online: [{ from: '2031-01-01', to: '2031-01-31', stated: 1, seen: 1 }],
      warehouse: [{ from: '2031-01-01', to: '2031-01-31', stated: null, seen: 1 }],
    },
    receipts: options.receipts ?? [warehouseReceipt(1)],
    held: options.held ?? [],
  };
  const validation = validateRetailImportPayload(structuredClone(payload));
  if (!validation.ok) throw new Error(`synthetic retail payload refused: ${JSON.stringify(validation.issues)}`);
  return payload;
}

/** A payload's file text (its canonical serialization). */
export const retailPayloadText = (payload: RetailImportPayload): string => serializeRetailImportPayload(payload);

/**
 * Every invented value a payload above holds that must never reach an output: card and membership endings, titles, the
 * declaration label, natural keys and the capture digest. Search output with `valueFreeText` first: a lowercase-hex digest
 * can hold any four digits by chance.
 */
export const SYNTHETIC_RETAIL_VALUES = /0007|0011|0042|SAMPLE WIDGET|SAMPLE GADGET|SAMPLE BULLION|Sample Household|costco-(?:receipt|order|line)-|bbbbbbbbbbbbbbbb/;
/** Output text with every 32- and 64-character lowercase-hex digest (GO ids, SHA-256s, plan and evidence digests) removed. */
export const valueFreeText = (text: string): string => text.replace(/\b[0-9a-f]{64}\b|\b[0-9a-f]{32}\b/g, '<digest>');
