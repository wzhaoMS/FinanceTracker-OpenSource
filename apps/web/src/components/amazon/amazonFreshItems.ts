import type { FreshUnitPrice, FreshWeight } from './amazonFreshApi';

/**
 * Amazon Fresh lines in the two Amazon item views (GET /amazon/spending and GET /amazon/spending/taxonomy): what an
 * answer says of them, read strictly. A Fresh order counts there by its Item List only, exactly as the Amazon Fresh tab
 * counts it. These readers return undefined for anything malformed; the views' parsers then refuse the whole answer.
 */

/** Who gave a Fresh line its card category: its item category's card category, or Groceries' as a default. */
export type AmazonFreshCardSource = 'item-taxonomy' | 'fresh-default';
export const AMAZON_FRESH_CARD_SOURCES: readonly AmazonFreshCardSource[] = ['item-taxonomy', 'fresh-default'];

/** What a Fresh line's Item List showed of it, beside its price. */
export interface AmazonFreshLineShown {
  status: 'listed' | 'substituted';
  quantity: number | null;
  weight: FreshWeight | null;
  unitPrice: FreshUnitPrice | null;
}
/** A Fresh product's lines together, as the Fresh tab shows a product: the quantities they showed, their weights exactly. */
export interface AmazonFreshMeasure {
  quantity: number | null;
  weight: { value: string; unit: 'lb'; estimated: boolean } | null;
}
export interface AmazonFreshPartTotals {
  currency: string;
  lineMinor: number;
  refundMinor: number;
  lineRefundMinor: number;
  unattributedRefundMinor: number;
  netLineMinor: number;
}
/**
 * What of a view's figures Amazon Fresh orders' Item List lines are: the orders, their delivered lines (counted), lines
 * not delivered and stored lines that couldn't be read (neither counted), and per currency their prices and refunds.
 */
export interface AmazonFreshPart {
  orders: number;
  lines: { priced: number; missing: number; unreadable: number };
  totals: AmazonFreshPartTotals[];
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isCurrency = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
/** The Item List contract's bounds (the API's freshSchema.ts): a line's price or unit price, and its count. */
const MAX_LINE_MINOR = 100_000_000;
const MAX_QUANTITY = 999;
/** A line's weight as an Item List shows it: positive, at most six digits either side of the point. */
const isLineWeight = (value: unknown): value is string => typeof value === 'string'
  && /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(value) && /[1-9]/.test(value);
/** A product's weights added up: positive, exact to the millionth of a pound. */
const isWeightSum = (value: unknown): value is string => typeof value === 'string'
  && /^(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/.test(value) && /[1-9]/.test(value);
/** Exact pounds as millionths, so weights add and compare without float error. */
export function freshMicroPounds(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
const isQuantity = (value: unknown): value is number | null => value === null || (isCount(value) && value >= 1 && value <= MAX_QUANTITY);

function unitPrice(raw: unknown, weighed: boolean): FreshUnitPrice | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw) || (raw.per !== 'each' && raw.per !== 'lb') || (raw.per === 'lb' && !weighed) || !isRecord(raw.money)
    || !isCurrency(raw.money.currency) || !isCount(raw.money.amountMinor) || raw.money.amountMinor > MAX_LINE_MINOR) return undefined;
  return { money: { currency: raw.money.currency, amountMinor: raw.money.amountMinor }, per: raw.per };
}

/** A Fresh line's own count, weight and unit price, as the Item List contract admits them, delivered as listed or as a substitute. */
export function readFreshLineShown(raw: unknown): AmazonFreshLineShown | undefined {
  if (!isRecord(raw) || (raw.status !== 'listed' && raw.status !== 'substituted') || !isQuantity(raw.quantity)) return undefined;
  let weight: FreshWeight | null = null;
  if (raw.weight !== null) {
    const shown = raw.weight;
    if (!isRecord(shown) || !isLineWeight(shown.value) || shown.unit !== 'lb'
      || (shown.basis !== 'actual' && shown.basis !== 'estimated' && shown.basis !== 'unlabeled')) return undefined;
    weight = { value: shown.value, unit: 'lb', basis: shown.basis };
  }
  const price = unitPrice(raw.unitPrice, weight !== null);
  if (price === undefined) return undefined;
  return { status: raw.status, quantity: raw.quantity, weight, unitPrice: price };
}

/** A Fresh product's quantity (null when no line showed one) and exact weight (null when no line showed one). */
export function readFreshMeasure(raw: unknown): AmazonFreshMeasure | undefined {
  if (!isRecord(raw) || (raw.quantity !== null && (!isCount(raw.quantity) || raw.quantity < 1))) return undefined;
  if (raw.weight === null) return { quantity: raw.quantity, weight: null };
  const weight = raw.weight;
  if (!isRecord(weight) || !isWeightSum(weight.value) || weight.unit !== 'lb' || typeof weight.estimated !== 'boolean') return undefined;
  return { quantity: raw.quantity, weight: { value: weight.value, unit: 'lb', estimated: weight.estimated } };
}

/** Whether a product's measure is exactly what its listed lines showed together (when it lists them all). */
export function freshMeasureFits(measure: AmazonFreshMeasure, lines: readonly AmazonFreshLineShown[]): boolean {
  const counted = lines.filter((line) => line.quantity !== null), weighed = lines.filter((line) => line.weight !== null);
  const quantity = counted.length ? counted.reduce((sum, line) => sum + line.quantity!, 0) : null;
  if (measure.quantity !== quantity || (measure.weight === null) !== (weighed.length === 0)) return false;
  return measure.weight === null || (freshMicroPounds(measure.weight.value)
    === weighed.reduce((sum, line) => sum + freshMicroPounds(line.weight!.value), 0n)
    && measure.weight.estimated === weighed.some((line) => line.weight!.basis === 'estimated'));
}

/** A view's Fresh part, checked whole: its counts, and each currency's prices, refunds and net adding up. */
export function readFreshPart(raw: unknown): AmazonFreshPart | undefined {
  if (!isRecord(raw) || !isCount(raw.orders) || raw.orders < 1 || !isRecord(raw.lines) || !Array.isArray(raw.totals)
    || raw.totals.length > 50) return undefined;
  const { priced, missing, unreadable } = raw.lines;
  if (!isCount(priced) || !isCount(missing) || !isCount(unreadable)) return undefined;
  const totals: AmazonFreshPartTotals[] = [];
  for (const entry of raw.totals) {
    if (!isRecord(entry) || !isCurrency(entry.currency) || totals.some((total) => total.currency === entry.currency)) return undefined;
    const { lineMinor, refundMinor, lineRefundMinor, unattributedRefundMinor, netLineMinor } = entry;
    if (!isCount(lineMinor) || !isCount(refundMinor) || !isCount(lineRefundMinor) || !isCount(unattributedRefundMinor)
      || !isCount(netLineMinor) || lineRefundMinor + unattributedRefundMinor > lineMinor
      || netLineMinor !== lineMinor - lineRefundMinor - unattributedRefundMinor) return undefined;
    totals.push({ currency: entry.currency, lineMinor, refundMinor, lineRefundMinor, unattributedRefundMinor, netLineMinor });
  }
  return { orders: raw.orders, lines: { priced, missing, unreadable }, totals };
}

/**
 * Whether a view's Fresh part fits the view's own figures: never more orders or lines than it has, every currency one of
 * its own, and per currency no more prices, refunds or net than its totals (each order's net is never below zero).
 */
export function freshPartFits(part: AmazonFreshPart, view: { orders: number; priced: number;
  totals: ReadonlyArray<{ currency: string; itemMinor: number; refundMinor?: number; itemRefundMinor?: number;
    unattributedRefundMinor?: number; netItemMinor?: number }> }): boolean {
  if (part.orders > view.orders || part.lines.priced > view.priced) return false;
  return part.totals.every((fresh) => {
    const total = view.totals.find((entry) => entry.currency === fresh.currency);
    return total !== undefined && fresh.lineMinor <= total.itemMinor
      && (total.refundMinor === undefined || (fresh.refundMinor <= total.refundMinor && fresh.lineRefundMinor <= (total.itemRefundMinor ?? 0)
        && fresh.unattributedRefundMinor <= (total.unattributedRefundMinor ?? 0) && fresh.netLineMinor <= (total.netItemMinor ?? 0)));
  });
}

/**
 * Whether a view's listed Fresh products fit its Fresh part: there is one when any is listed, and they hold no more lines,
 * prices or refunds than it says.
 */
export function freshProductsFit(part: AmazonFreshPart | undefined,
  products: ReadonlyArray<{ currency: string; lines: number; amountMinor: number; refundMinor?: number; fresh?: AmazonFreshMeasure }>): boolean {
  const fresh = products.filter((product) => product.fresh !== undefined);
  if (!part) return fresh.length === 0;
  if (fresh.reduce((sum, product) => sum + product.lines, 0) > part.lines.priced) return false;
  return part.totals.every((total) => {
    const inCurrency = fresh.filter((product) => product.currency === total.currency);
    return inCurrency.reduce((sum, product) => sum + product.amountMinor, 0) <= total.lineMinor
      && inCurrency.reduce((sum, product) => sum + (product.refundMinor ?? 0), 0) <= total.lineRefundMinor;
  }) && fresh.every((product) => part.totals.some((total) => total.currency === product.currency));
}
