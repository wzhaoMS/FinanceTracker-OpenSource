/**
 * Synthetic Costco retail payloads (`holdr.retail-import`) for the Costco adapter's tests: invented keys, items,
 * titles, amounts and card endings only, never a household's data. Records are built in format 3 (retail policy 5, the
 * one the adapter reads), and `retailPayload` can also write them in format 2 (policy 4) or format 1 (policy 3), which
 * it refuses.
 *
 * Amounts are integer cents. Every builder keeps the retail money identities, so a payload passes its format's
 * validator, and metal evidence and packs come from the retail rules themselves unless a test states them. The title
 * guard's flag is stated by a test (`metalUncertain`), never derived: the adapter takes it as written, and a flagged
 * line has no metal evidence.
 */

import { retailMetalPack, type RetailMetalPack } from '../../../retailImportTool/metalPackRule.js';
import { RETAIL_METAL_GUARD, retailMetalTitleEvidence } from '../../../retailImportTool/metalTitleRule.js';
import { COSTCO_CAPTURE_SCHEMA, RETAIL_IMPORT_FORMAT, retailLineKey, retailNaturalKey } from '../../../retailImportTool/payload.js';

export const SYNTHETIC_CARD = '0007';
export const SYNTHETIC_CARD_2 = '0011';
export const SYNTHETIC_MEMBERSHIP = '0042';

type Rec = Record<string, unknown>;

/** A unit event: [quantity, date]. */
export type SyntheticEvent = readonly [number, string];

export interface SyntheticEvents {
  shipped?: SyntheticEvent[];
  delivered?: SyntheticEvent[];
  cancelled?: SyntheticEvent[];
  returned?: SyntheticEvent[];
}

/** A shipment record; its dates default to none. */
export interface SyntheticShipment {
  shipped?: string | null;
  delivered?: string | null;
}

/** Metal evidence as the retail converter wrote it; `pack` is from format 2 on and is dropped for format 1. */
export interface SyntheticMetal {
  metal: string | null;
  form: string | null;
  statedWeight: { value: string; unit: string } | null;
  rule: string;
  pack: RetailMetalPack;
}

/** The title guard's flag as the retail converter wrote it (format 3): the guard, the evidence that fired, the metal. */
export interface SyntheticFlag {
  guard: string;
  evidence: string[];
  metal: string | null;
}

/** A flag of the retail tool's guard, its evidence in the guard's closed order. */
export const syntheticFlag = (evidence: string[], metal: string | null): SyntheticFlag => ({ guard: RETAIL_METAL_GUARD, evidence, metal });

/** The retail rules on a raw title: the title rule's evidence with the pack rule's pack, or null. */
export function metalOf(raw: string, pack?: RetailMetalPack): SyntheticMetal | null {
  const evidence = retailMetalTitleEvidence(raw);
  return evidence === null ? null : { ...evidence, pack: pack ?? retailMetalPack(raw) };
}

export interface OnlineLineSpec {
  id: string;
  title: string;
  itemNumber?: string | null;
  quantity: number;
  unitPrice: number;
  /** Defaults to quantity × unit price. */
  amount?: number;
  shipping?: number;
  /** A fee line: the ordinal of its parent line. */
  feeParent?: number;
  shipments?: SyntheticShipment[];
  events?: SyntheticEvents;
  storedValue?: 'costco-shop-card' | null;
  /** The pack the retail converter read on the raw title (default: the pack rule on the title). */
  pack?: RetailMetalPack;
  /** Metal evidence as written (default: the retail rules on the title; never on a fee or flagged line). */
  metal?: SyntheticMetal | null;
  /** The title guard's flag (default none). */
  metalUncertain?: SyntheticFlag | null;
}

export interface OnlineOrderSpec {
  id: string;
  date: string;
  status?: 'shipped' | 'delivered' | 'cancelled' | 'returned' | 'other';
  lines: OnlineLineSpec[];
  tax?: number;
  /** The discount; with `coupons`, the coupon tenders that repeat it. */
  discount?: number;
  coupons?: number[];
  /** Order-level fees (delivery fee, surcharges). */
  fees?: number;
  /** Format 2: the Shop Card amount applied; its tenders default to one of the whole amount. */
  storedValue?: number;
  shopCards?: number[];
  card?: { last4: string; network: 'visa' | 'mastercard' };
}

const events = (spec: SyntheticEvents | undefined) => ({
  shipped: (spec?.shipped ?? []).map(([quantity, date]) => ({ quantity, date })),
  delivered: (spec?.delivered ?? []).map(([quantity, date]) => ({ quantity, date })),
  cancelled: (spec?.cancelled ?? []).map(([quantity, date]) => ({ quantity, date })),
  returned: (spec?.returned ?? []).map(([quantity, date]) => ({ quantity, date })),
});

/** The natural keys a synthetic order or receipt gets. */
export const orderKey = (id: string) => retailNaturalKey('costco', 'order', `synthetic-order-${id}`);
export const receiptKey = (id: string) => retailNaturalKey('costco', 'receipt', `synthetic-receipt-${id}`);
export const lineKey = (orderId: string, lineId: string) => retailLineKey('costco', `synthetic-order-${orderId}`, `line-${lineId}`);

/** One online order in format 3, its totals and tenders computed from its lines. */
export function onlineOrder(spec: OnlineOrderSpec): Rec {
  const lines = spec.lines.map((line, ordinal) => {
    const fee = line.feeParent !== undefined;
    const amount = line.amount ?? line.quantity * line.unitPrice;
    const flag = line.metalUncertain ?? null;
    return {
      ordinal,
      lineKey: lineKey(spec.id, line.id),
      kind: fee ? 'fee' : 'item',
      itemNumber: line.itemNumber === undefined ? `1000${ordinal + 1}` : line.itemNumber,
      title: line.title,
      title2: null,
      department: null,
      quantity: line.quantity,
      unitPriceMinor: line.unitPrice,
      amountMinor: amount,
      shippingMinor: line.shipping ?? 0,
      taxFlag: null,
      couponTarget: null,
      feeParent: fee ? line.feeParent : null,
      fulfilment: 'parcel',
      metal: line.metal !== undefined ? line.metal : fee || flag !== null ? null : metalOf(line.title, line.pack),
      metalUncertain: flag,
      storedValue: line.storedValue ?? null,
      fuelGallons: null,
      fuelUnitPrice: null,
      events: events(line.events),
      shipments: (line.shipments ?? []).map((shipment) => ({
        shippedDate: shipment.shipped ?? null, deliveredDate: shipment.delivered ?? null, estimatedArrivalDate: null, carrier: 'ups',
      })),
    };
  });
  const subtotal = lines.reduce((total, line) => total + line.amountMinor, 0);
  const shipping = lines.reduce((total, line) => total + line.shippingMinor, 0);
  const tax = spec.tax ?? 0;
  const discount = spec.discount ?? 0;
  const fees = spec.fees ?? 0;
  const stored = spec.storedValue ?? 0;
  const total = subtotal + shipping + tax - discount + fees - stored;
  const card = spec.card ?? { last4: SYNTHETIC_CARD, network: 'visa' };
  const chargedNothing = total === 0 && stored === 0;
  const tenders: Rec[] = [];
  if (!chargedNothing) {
    if (total > 0) tenders.push({ kind: 'card', network: card.network, last4: card.last4, amountMinor: total });
    for (const amount of spec.shopCards ?? (stored > 0 ? [stored] : [])) {
      tenders.push({ kind: 'shop-card', network: 'unknown', last4: null, amountMinor: amount });
    }
    for (const amount of spec.coupons ?? []) tenders.push({ kind: 'coupon', network: 'unknown', last4: null, amountMinor: amount });
  }
  return {
    channel: 'online',
    naturalKey: orderKey(spec.id),
    date: spec.date,
    localTime: null,
    sign: 'sale',
    status: spec.status ?? 'delivered',
    currency: 'USD',
    totals: {
      subtotalMinor: subtotal, taxMinor: tax, instantSavingsMinor: null, discountMinor: discount, shippingMinor: shipping,
      feesMinor: fees, storedValueMinor: stored, totalMinor: total,
    },
    taxLegends: [],
    lines,
    tenders: tenders.map((tender, ordinal) => ({ ordinal, ...tender })),
  };
}

export interface WarehouseLineSpec {
  title: string;
  title2?: string | null;
  itemNumber?: string | null;
  kind?: 'item' | 'coupon' | 'fuel';
  quantity?: number | null;
  unitPrice?: number | null;
  amount: number;
  taxFlag?: string | null;
  couponTarget?: number | null;
  pack?: RetailMetalPack;
  metal?: SyntheticMetal | null;
  /** The title guard's flag (default none). */
  metalUncertain?: SyntheticFlag | null;
}

export interface WarehouseTenderSpec {
  kind: 'card' | 'card-refund' | 'debit' | 'cash' | 'shop-card' | 'reward-certificate';
  amount: number;
  last4?: string;
}

export interface WarehouseReceiptSpec {
  id: string;
  date: string;
  gas?: boolean;
  lines: WarehouseLineSpec[];
  tax?: number;
  tenders: WarehouseTenderSpec[];
}

/** One warehouse (or gas) receipt in format 3: a sale when its total is positive, a refund when negative. */
export function warehouseReceipt(spec: WarehouseReceiptSpec): Rec {
  const lines = spec.lines.map((line, ordinal) => {
    const kind = line.kind ?? 'item';
    const raw = [line.title, line.title2 ?? ''].join(' ').trim();
    const flag = line.metalUncertain ?? null;
    return {
      ordinal,
      lineKey: null,
      kind,
      itemNumber: line.itemNumber === undefined ? `2000${ordinal + 1}` : line.itemNumber,
      title: kind === 'coupon' ? null : line.title,
      title2: kind === 'coupon' ? null : (line.title2 ?? null),
      department: null,
      quantity: line.quantity === undefined ? 1 : line.quantity,
      unitPriceMinor: kind === 'fuel' ? null : line.unitPrice === undefined ? line.amount : line.unitPrice,
      amountMinor: line.amount,
      shippingMinor: null,
      taxFlag: line.taxFlag === undefined ? 'N' : line.taxFlag,
      couponTarget: kind === 'coupon' ? (line.couponTarget ?? null) : null,
      feeParent: null,
      fulfilment: null,
      metal: line.metal !== undefined ? line.metal : kind === 'item' && flag === null ? metalOf(raw, line.pack) : null,
      metalUncertain: flag,
      storedValue: null,
      fuelGallons: kind === 'fuel' ? '10.5' : null,
      fuelUnitPrice: kind === 'fuel' ? '3.459' : null,
      events: null,
      shipments: [],
    };
  });
  const subtotal = lines.reduce((total, line) => total + line.amountMinor, 0);
  const tax = spec.tax ?? 0;
  const total = subtotal + tax;
  return {
    channel: spec.gas ? 'gas' : 'warehouse',
    naturalKey: receiptKey(spec.id),
    date: spec.date,
    localTime: null,
    sign: total > 0 ? 'sale' : 'refund',
    status: null,
    currency: 'USD',
    totals: {
      subtotalMinor: subtotal, taxMinor: tax, instantSavingsMinor: null, discountMinor: null, shippingMinor: null, feesMinor: null,
      storedValueMinor: null, totalMinor: total,
    },
    taxLegends: [],
    lines,
    tenders: spec.tenders.map((tender, ordinal) => ({
      ordinal,
      kind: tender.kind,
      network: tender.kind === 'card' ? 'visa' : 'unknown',
      last4: tender.kind === 'card' || tender.kind === 'card-refund' ? (tender.last4 ?? SYNTHETIC_CARD) : null,
      amountMinor: tender.amount,
    })),
  };
}

export interface SyntheticHeld {
  channel: 'online' | 'warehouse' | 'gas';
  /** Null only for `record-key`. */
  key: string | null;
  reason: string;
  check: string;
  /** From format 2 on: the date. */
  date?: string | null;
}

export interface RetailPayloadSpec {
  format: 1 | 2 | 3;
  receipts?: Rec[];
  held?: SyntheticHeld[];
  membershipLast4?: string | null;
  folder?: string;
  coverage?: { online?: Rec[]; warehouse?: Rec[] };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A record in format 2: without the title guard's flag. */
function asFormat2(receipt: Rec): Rec {
  const copy = clone(receipt);
  for (const line of copy.lines as Rec[]) delete line.metalUncertain;
  return copy;
}

/** A record in format 1: without the flag, the Shop Card amount, the stored-value flag and the pack. */
function asFormat1(receipt: Rec): Rec {
  const copy = asFormat2(receipt);
  delete (copy.totals as Rec).storedValueMinor;
  for (const line of copy.lines as Rec[]) {
    delete line.storedValue;
    if (line.metal !== null) delete (line.metal as Rec).pack;
  }
  return copy;
}

/** The retail converter and policy that write each format. */
const WRITERS = {
  1: { converterVersion: 'holdr-retail-convert 1.2.0', policyVersion: 3, record: asFormat1 },
  2: { converterVersion: 'holdr-retail-convert 1.3.0', policyVersion: 4, record: asFormat2 },
  3: { converterVersion: 'holdr-retail-convert 1.4.0', policyVersion: 5, record: (receipt: Rec): Rec => clone(receipt) },
} as const;

/** One membership's retail payload in the given format: format 1 is policy 3, format 2 policy 4, format 3 policy 5. */
export function retailPayload(spec: RetailPayloadSpec): Rec {
  const writer = WRITERS[spec.format];
  return {
    format: RETAIL_IMPORT_FORMAT,
    version: spec.format,
    merchant: 'costco',
    converterVersion: writer.converterVersion,
    policyVersion: writer.policyVersion,
    source: { schema: COSTCO_CAPTURE_SCHEMA, captureDigest: 'c'.repeat(64), capturedAt: '2030-12-31T12:00:00Z', files: 3 },
    membership: {
      folder: spec.folder ?? 'costco',
      memberSinceYear: null,
      tier: null,
      membershipLast4: spec.membershipLast4 === undefined ? SYNTHETIC_MEMBERSHIP : spec.membershipLast4,
    },
    coverage: {
      online: spec.coverage?.online ?? [{ from: '2030-01-01', to: '2030-12-31', stated: 4, seen: 4 }],
      warehouse: spec.coverage?.warehouse ?? [{ from: '2030-01-01', to: '2030-12-31', stated: null, seen: 2 }],
    },
    receipts: (spec.receipts ?? []).map((receipt) => writer.record(receipt)),
    held: (spec.held ?? []).map((held) => {
      const record: Rec = { channel: held.channel, naturalKey: held.key, reason: held.reason, check: held.check };
      if (spec.format !== 1) record.date = held.date ?? null;
      return record;
    }),
  };
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Rec)[key])]));
  }
  return value;
}

/** A payload's file bytes, as the retail converter writes them: canonical JSON, keys sorted. */
export function retailBytes(payload: Rec): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(sorted(payload), null, 2)}\n`);
}
