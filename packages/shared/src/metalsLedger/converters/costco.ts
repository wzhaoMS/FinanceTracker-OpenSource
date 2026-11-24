/**
 * The Costco adapter (design v8 §5.2), payload to payload: one validated `holdr.retail-import` (merchant `costco`,
 * retail policy 5 in format 3) to one `holdr.metals-import` v1 payload, source `costco`. It reads no capture file,
 * only the retail payload's bytes, whose SHA-256 is the metals payload's input. Every earlier policy is refused: every
 * Costco payload is converted again at policy 5 before any import (ROOT's ruling, narrowing §5.2's "policy 3 or 4").
 *
 * Metal evidence is the retail converter's `line.metal`, taken as written: it was read on the raw title before any
 * sanitizing, so it is never derived again from a stored title. So is the title guard's flag, `line.metalUncertain`: a
 * line whose title reads as no metal but names one with bullion evidence is metal-uncertain, never silently no metal.
 * Only an item line can be a lot, and a line that buys a Shop Card never is. The pack is `line.metal.pack`, a pinned
 * raw-derived observation (`unknown` on a flagged line, which has no metal evidence). Costco lines carry no purity,
 * mass-basis or design evidence, so in v1 only the owner's confirmation gives them fine content: the content rule
 * holds every Costco lot until then, and a flagged lot first until the owner's bullion decision.
 *
 * - An online order with a metal or flagged line is an order, those lines lots and their events lot events. Its funding
 *   is its card tender (of `totalMinor`, when that is positive) and its Shop Card tenders (the funding of
 *   `storedValueMinor`). Its fulfilment is its shipment records counted order-wide, null when there is none; a shared
 *   shipped date never counts as one shipment. Coupon tenders repeat the discount, which the skeleton carries, so they
 *   are never funding. Full price = total + stored value.
 * - A warehouse sale receipt with a metal or flagged line is an order, those lines lots delivered at the register on the
 *   receipt date (`in-store`). A gas receipt is an in-person receipt too: its card funding competes as a warehouse
 *   receipt's does.
 * - A flagged line is carried in full (contract follow-up 1): a lot with no metal and its flag as written, its skeleton
 *   line metal (provisionally bullion), and its order with no card evidence, whatever its funding would admit. A flag or
 *   metal evidence on a line that can't be a lot (a fee, fuel or coupon line, or a Shop Card purchase) holds its whole
 *   record: neither rides on a line that isn't a lot, so the census can show that no metal or flagged line is lost.
 * - Card evidence comes only from metalsAdmission (`costco-settled-tender@1`). Every other sale's card funding is a
 *   competitor, single-charge or aggregate as metalsAdmission says; a record with no card funding is neither. A refund
 *   receipt is a credit: it funds no order (a gross total is never negative), so it is no competitor.
 * - Held, with key, channel and date: a refund receipt's metal or flagged line (`return-unlinked`), a lot line with no
 *   positive quantity (`quantity-unknown`), events or a status a lot can't carry (`status-ambiguous`), anything else the
 *   ledger has no reviewed rule for, and every record the retail payload holds (`retail-held`, with its check and date).
 *
 * Pure: no file system, network or clock. A result passes validateMetalsImportPayload, or the conversion is refused.
 */

import { cardImportTextProblem } from '../../cardImport.js';
import { retailMetalPack } from '../../retailImportTool/metalPackRule.js';
import { RETAIL_METAL_GUARD, RETAIL_METAL_GUARD_EVIDENCE, retailMetalTitleGuard } from '../../retailImportTool/metalTitleRule.js';
import {
  RETAIL_CONVERT_POLICY_VERSION,
  RETAIL_IMPORT_FORMAT,
  RETAIL_IMPORT_VERSION,
  validateRetailImportPayload,
  type RetailImportLine,
  type RetailImportPayload,
  type RetailImportReceipt,
  type RetailImportTender,
  type RetailLineMetalUncertain,
} from '../../retailImportTool/payload.js';
import { metalsAdmission, metalsSettlementInterval } from '../admission.js';
import { metalsAllocation, metalsSkeletonProblem, type MetalsAllocation } from '../allocation.js';
import { metalsContentFingerprint, metalsFineContent, metalsFineContentWire, type MetalsContentEvidence } from '../contentRule.js';
import {
  METAL_FORMS,
  METAL_PACKS,
  METALS,
  METALS_CONTENT_HOLDS,
  METALS_CONVERT_POLICY_VERSION,
  METALS_GUARD_EVIDENCE,
  METALS_HOLD_REASONS,
  METALS_IMPORT_FORMAT,
  METALS_IMPORT_VERSION,
  METALS_RULES,
  METALS_TITLE_GUARD,
  type Metal,
  type MetalForm,
  type MetalPack,
  type MetalsAdmissionFacts,
  type MetalsChannel,
  type MetalsContentHold,
  type MetalsEvent,
  type MetalsHoldReason,
  type MetalsLineMetalUncertain,
  type MetalsOrderComponent,
  type MetalsSkeletonLine,
  type MetalsTaxFlag,
  type MetalsTender,
} from '../model.js';
import {
  METALS_MAX_EVENTS,
  METALS_MAX_LINES,
  METALS_MAX_MINOR,
  METALS_RETAIL_INPUTS,
  METALS_TITLE_MAX,
  metalsDigest,
  metalsNaturalKey,
  type MetalsCompetitor,
  type MetalsCoverage,
  type MetalsHeldRecord,
  type MetalsImportPayload,
  type MetalsLine,
  type MetalsOrder,
} from '../payload.js';
import {
  MetalsConvertError,
  metalsConvertOutput,
  type MetalsConvertOutput,
  type MetalsRetailPayloadConverter,
  type MetalsRetailPayloadFile,
  metalsOwnerQuestionCounts,
  type MetalsBullionCounts,
  type MetalsConfirmationCounts,
} from './common.js';

/**
 * The one retail format the adapter reads, and its policy: policy 5 in format 3, the format this build's retail
 * validator reads. Policies 3 and 4 (formats 1 and 2) are refused, since every Costco payload is converted again at
 * policy 5 before any import (ROOT's ruling). The literal types tie the adapter to that format: a retail format or
 * policy that moves on doesn't compile here until the adapter is reviewed for it, and the pair must be one the metals
 * contract reads (`METALS_RETAIL_INPUTS`).
 */
export const METALS_COSTCO_RETAIL_FORMAT: 3 = RETAIL_IMPORT_VERSION;
export const METALS_COSTCO_RETAIL_POLICY: 5 = RETAIL_CONVERT_POLICY_VERSION;
export const METALS_COSTCO_RETAIL_INPUT = {
  format: METALS_COSTCO_RETAIL_FORMAT,
  policy: METALS_COSTCO_RETAIL_POLICY,
} as const satisfies (typeof METALS_RETAIL_INPUTS)[number];

/**
 * The title guard whose flags the adapter takes: retail policy 5's metal guard, which is the contract's
 * `METALS_TITLE_GUARD` with the same evidence codes in the same closed order. A guard or vocabulary that moves on in
 * either doesn't compile here until the adapter is reviewed for it.
 */
export const METALS_COSTCO_TITLE_GUARD = {
  guard: RETAIL_METAL_GUARD,
  evidence: RETAIL_METAL_GUARD_EVIDENCE,
} as const satisfies { guard: typeof METALS_TITLE_GUARD; evidence: typeof METALS_GUARD_EVIDENCE };

/**
 * Why the adapter refuses a whole retail payload (a MetalsConvertError's code): nothing of it is converted.
 * - `converter-version`: the converting program isn't named `holdr-metals-convert <semver>`.
 * - `retail-unreadable`: the bytes aren't UTF-8 JSON.
 * - `retail-invalid`: not a Costco holdr.retail-import, or the retail validator refuses it.
 * - `retail-policy-unsupported`: any format or policy but policy 5 in format 3 (at `$.policyVersion`), metal evidence
 *   under another title rule, or a flag of another guard.
 * - `converter-invalid`: the adapter's own payload fails validateMetalsImportPayload (a fault of the adapter).
 */
export const METALS_COSTCO_REFUSALS = [
  'converter-version',
  'retail-unreadable',
  'retail-invalid',
  'retail-policy-unsupported',
  'converter-invalid',
] as const;
export type MetalsCostcoRefusal = (typeof METALS_COSTCO_REFUSALS)[number];

/**
 * The adapter's own holds: each a closed check under one reason. A record the retail payload held keeps its retail
 * check under `retail-held`; none of these names is a retail check.
 */
export const METALS_COSTCO_HOLD_CHECKS = {
  /**
   * A line the title guard flagged that can't be a lot: a fee or fuel line (the guard reads them too), or a line that
   * buys a Shop Card (which the retail validator refuses). A flag never rides on a line that isn't a lot, so the whole
   * record is held: fail-closed, a held record bars its whole merchant class.
   */
  'flag-not-item': 'field-unsupported',
  /**
   * A line with the title rule's metal evidence that can't be a lot: a fee, fuel or coupon line, or a line that buys a
   * Shop Card. The retail validator refuses both, so this is a defence only: metal evidence never rides on a line that
   * isn't a lot, and no retail metal line is lost.
   */
  'metal-not-item': 'field-unsupported',
  /** A refund receipt with a metal or flagged line: an unresolved return, never a negative lot, never matched by guess (§4.3). */
  'refund-receipt-metal': 'return-unlinked',
  /** A lot line whose quantity is null, zero or negative. */
  'metal-quantity': 'quantity-unknown',
  /** A lot line whose amount is negative. */
  'metal-amount': 'field-unsupported',
  /** A metal line with more events than a lot carries. */
  'event-count': 'field-unsupported',
  /** A metal line's events: one of more units than the line has, more cancelled and delivered than ordered, or more returned than delivered. */
  'event-units': 'status-ambiguous',
  /** A metal line's event dated before its order: the two dates contradict each other, and neither is guessed right. */
  'event-before-order': 'status-ambiguous',
  /** The order says returned, but no line of it states a return. */
  'return-unstated': 'status-ambiguous',
  /** The order says cancelled, but a metal line has units no cancel event covers. */
  'cancel-unstated': 'status-ambiguous',
  /** A negative tax: a component of the wrong sign. */
  'tax-sign': 'field-unsupported',
  /**
   * A method of the wrong sign for its kind: a negative amount on anything but a card refund (a cash tender given back as
   * change, say), or a card refund that isn't negative. Such funding contradicts itself, so an order or competitor
   * carrying it is held, which bars every amount.
   */
  'method-sign': 'field-unsupported',
  /** A negative retail discount, one that would add to the price: a component of the wrong sign (a discount is held only so). */
  'discount-sign': 'field-unsupported',
  /** More money lines than a skeleton carries. */
  'skeleton-size': 'field-unsupported',
  /** A skeleton the allocation rule can't read (a structural fault). */
  'skeleton-shape': 'field-unsupported',
  /** More shipment records than the admission facts carry. */
  'shipment-records': 'field-unsupported',
  /** The skeleton's full price is not total + stored value. */
  'full-price': 'identity-failed',
  /**
   * The pack says one piece per unit, but the stored title shows a pack marker. The validator refuses such a line, so
   * the order is held, failing closed. The stored title is normalized and cut, so this can fire on a correct `single`
   * (a cut that leaves "Pack" of "Packaging"): its reason is the closed list's nearest, two readings of one capture
   * field disagreeing (the raw title's pack and the stored title).
   */
  'pack-title': 'capture-disagreement',
} as const satisfies Record<string, MetalsHoldReason>;
export type MetalsCostcoHoldCheck = keyof typeof METALS_COSTCO_HOLD_CHECKS;
export const METALS_COSTCO_HOLD_CHECK_NAMES = Object.keys(METALS_COSTCO_HOLD_CHECKS) as MetalsCostcoHoldCheck[];

/**
 * Why a lot's stored title is withheld (the title null; the line and its raw-derived facts kept), counted in the report:
 * `metal-guard`, an unflagged line whose final stored title the title guard reads as metal-uncertain on its own, since
 * the retail tool's cut, a null part or the warehouse fallback left out what made it metal. 1E's validator refuses such
 * a title, so it is never stored. Closed.
 */
export const METALS_COSTCO_TITLE_WITHHELD = ['metal-guard'] as const;
export type MetalsCostcoTitleWithheld = (typeof METALS_COSTCO_TITLE_WITHHELD)[number];

type Counts<K extends string> = Record<K, number>;
const zeroes = <K extends string>(keys: readonly K[]): Counts<K> => Object.fromEntries(keys.map((key) => [key, 0])) as Counts<K>;

/** What a conversion found: counts, closed codes, dates and the folder's name only, never an amount, title or key. */
export type MetalsCostcoConvertReport = {
  converter: string;
  source: 'costco';
  folder: string;
  membershipIdentity: 'stated' | 'none';
  retail: { format: typeof METALS_COSTCO_RETAIL_FORMAT; policyVersion: typeof METALS_COSTCO_RETAIL_POLICY; records: number; held: number };
  /**
   * Every retail record is exactly one of: an order, a competitor, held by the adapter, a credit (a refund receipt with
   * no metal or flagged line: it funds no order and is no competitor), or neither (no lot line and no card funding).
   */
  records: { orders: number; competitors: number; held: number; credits: number; noCardFunding: number };
  orders: { online: number; warehouse: number };
  lots: {
    online: number;
    warehouse: number;
    /** By the lot's own metal: a flagged lot has none until the owner decides it is bullion. */
    byMetal: Counts<Metal | 'none'>;
    byForm: Counts<MetalForm | 'none'>;
    byPack: Counts<MetalPack>;
    withWeight: number;
    costComplete: number;
    /** Each lot's primary content hold. Only the owner confirms a Costco lot's content in v1. */
    byContentHold: Counts<MetalsContentHold>;
    /** The lots the title guard flagged, and the metal each flag names (`none` when it names several). */
    flagged: number;
    flaggedByMetal: Counts<Metal | 'none'>;
    /** The lots whose stored title was withheld, by why (METALS_COSTCO_TITLE_WITHHELD). */
    titlesWithheldBy: Counts<MetalsCostcoTitleWithheld>;
  };
  /**
   * The owner's one-time content confirmations the unflagged lots need (§4.4.1): one per product ref and content
   * fingerprint among the `single`-pack lots with a ref (`productScoped`), and one per lot for every other lot with a
   * metal (`lotScoped`). A lot whose title names several metals can't be confirmed (a decision never names the metal),
   * so it is counted apart (`metalUnknown`). `notCancelledOrReturned` counts the same over the lots with a unit neither
   * cancelled nor returned (delivered and kept, or awaiting delivery): a lot whose every unit was cancelled or returned
   * changes no figure on the page, whatever it contains.
   *
   * The owner's question Q1 is answered by `needed`: product-scoped plus lot-scoped, over the unflagged lots with a unit
   * kept or on the way. `neededIncludingFullyCancelledOrReturned` is the same over every unflagged lot, reported beside
   * it. A flagged lot needs its bullion decision first (`bullion`): content alone never releases the bullion hold.
   * Both blocks are the shared `metalsOwnerQuestionCounts` (common.ts), which every source's report states alike.
   */
  confirmations: MetalsConfirmationCounts;
  /**
   * Q1b, beside Q1: the owner's bullion decisions the flagged lots need, over the flagged lots with a unit kept or on
   * the way. A bullion decision is product-wide by product ref and content fingerprint (the whole flag included),
   * whatever the pack (`productScoped`), and lot-scoped for a lot with no ref (`lotScoped`); `needed` is their sum.
   * `includingFullyCancelledOrReturned` counts the same over every flagged lot.
   */
  bullion: MetalsBullionCounts;
  /** `costco-settled-tender@1` evidence, by channel. */
  evidence: { online: number; warehouse: number };
  competitors: { online: number; warehouse: number; fromGas: number; singleCharge: number; aggregate: number };
  held: { retail: number; adapter: number; byReason: Counts<MetalsHoldReason>; byCheck: Record<string, number> };
  /**
   * The census, two exact identities (contract follow-up 1): no retail metal line or flagged line is lost, unflagged or
   * routed elsewhere. Metal lines are the retail lines with the title rule's evidence (`line.metal`, whatever metal it
   * names), flagged lines those with the title guard's flag; each is a lot of an order or a line of a record the
   * adapter held, so `retailMetalLines = metalLinesInOrders + metalLinesInHeldRecords` ("metal in = metal out") and
   * `retailFlaggedLines = flaggedLinesInOrders + flaggedLinesInHeldRecords` ("flags in = flags out"). Diagnostics
   * (holds first): `heldMetalWordLines` counts every line with metal evidence or a flag in a record the adapter held,
   * and `heldAlsoFlaggedOrders` the records it held that have a flagged line.
   */
  census: {
    retailMetalLines: number;
    metalLinesInOrders: number;
    metalLinesInHeldRecords: number;
    retailFlaggedLines: number;
    flaggedLinesInOrders: number;
    flaggedLinesInHeldRecords: number;
    heldMetalWordLines: number;
    heldAlsoFlaggedOrders: number;
  };
  coverage: { online: number; warehouse: number; complete: number };
  dates: { first: string | null; last: string | null };
};

export type MetalsCostcoConvertResult = MetalsConvertOutput<MetalsCostcoConvertReport>;

/** A retail payload the retail validator accepted (policy 5, format 3), with the SHA-256 of its file and the program. */
export interface MetalsCostcoRetailSource {
  retail: RetailImportPayload;
  /** SHA-256 of the retail payload file's bytes, in letter hex. */
  retailPayloadSha256: string;
  converterVersion: string;
}

const CONVERTER_VERSION = /^holdr-metals-convert \d{1,3}\.\d{1,3}\.\d{1,3}$/;
const LETTER_HEX = /^[a-p]{64}$/;
/** The most shipment records the admission facts carry (the validator's bound). */
const MAX_SHIPMENT_RECORDS = 1000;

/** A record the adapter holds, by the check it failed. */
class Hold extends Error {
  constructor(readonly check: MetalsCostcoHoldCheck) {
    super(check);
  }
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

// ---------------------------------------------------------------------------
// One record
// ---------------------------------------------------------------------------

/**
 * A lot: an item line that buys no Shop Card (its `storedValue` flag), with the title rule's metal evidence or the
 * title guard's flag.
 */
const isLotLine = (line: RetailImportLine): boolean =>
  line.kind === 'item' && line.storedValue === null && (line.metal !== null || line.metalUncertain !== null);

/** A flag on a line that can't be a lot: a fee or fuel line, or a Shop Card purchase (which the retail validator refuses). */
const isFlagOffLot = (line: RetailImportLine): boolean => line.metalUncertain !== null && !isLotLine(line);

/** Metal evidence on a line that can't be a lot: a fee, fuel or coupon line, or a Shop Card purchase. */
const isMetalOffLot = (line: RetailImportLine): boolean => line.metal !== null && !isLotLine(line);

/** The title guard's flag as the retail converter wrote it, in the contract's shape: the same fields, codes and order. */
const flagOf = (flag: RetailLineMetalUncertain): MetalsLineMetalUncertain => ({
  guard: flag.guard,
  evidence: [...flag.evidence],
  metal: flag.metal,
});

const channelOf = (receipt: RetailImportReceipt): MetalsChannel => (receipt.channel === 'online' ? 'online' : 'warehouse');

const tenderOf = (tender: RetailImportTender): MetalsTender => ({
  kind: tender.kind,
  network: tender.network,
  last4: tender.last4,
  amountMinor: tender.amountMinor,
});

const unitsOf = (events: ReadonlyArray<{ quantity: number }> | undefined) => sum((events ?? []).map((event) => event.quantity));

/** A sale's funding facts (§4.4.4), from which metalsAdmission decides evidence, basis and cap. Never a credit's. */
function admissionOf(receipt: RetailImportReceipt, channel: MetalsChannel): MetalsAdmissionFacts {
  if (channel === 'warehouse') {
    return {
      fulfilment: 'in-store',
      methods: receipt.tenders.map(tenderOf),
      refunded: false,
      cancelled: false,
      partlyCancelled: false,
      grossTotalMinor: receipt.totals.totalMinor,
    };
  }
  // Shipment records, counted order-wide across every line: never a count of shipped dates.
  const records = sum(receipt.lines.map((line) => line.shipments.length));
  if (records > MAX_SHIPMENT_RECORDS) throw new Hold('shipment-records');
  const cancelled = receipt.status === 'cancelled';
  return {
    fulfilment: { shipments: records > 0 ? records : null },
    // Coupon tenders repeat the discount the skeleton already carries: never funding.
    methods: receipt.tenders.filter((tender) => tender.kind !== 'coupon').map(tenderOf),
    refunded: receipt.status === 'returned' || receipt.lines.some((line) => unitsOf(line.events?.returned) > 0),
    cancelled,
    partlyCancelled: !cancelled && receipt.lines.some((line) => unitsOf(line.events?.cancelled) > 0),
    grossTotalMinor: receipt.totals.totalMinor + (receipt.totals.storedValueMinor ?? 0),
  };
}

/** A warehouse line's printed tax flag in the closed vocabulary: `Y` taxable, `N` not; any other code is not read. */
const taxFlagOf = (flag: string | null): MetalsTaxFlag | null => (flag === 'Y' ? 'taxable' : flag === 'N' ? 'non-taxable' : null);

function componentsOf(taxMinor: number, discountMinor: number): MetalsOrderComponent[] {
  if (taxMinor < 0) throw new Hold('tax-sign');
  if (discountMinor < 0) throw new Hold('discount-sign');
  const components: MetalsOrderComponent[] = [];
  if (taxMinor !== 0) components.push({ kind: 'tax', amountMinor: taxMinor });
  if (discountMinor !== 0) components.push({ kind: 'discount', amountMinor: -discountMinor });
  return components;
}

/** An online order's skeleton: its lines as they are, then its order-level fees as one unparented fee line. */
function onlineSkeleton(receipt: RetailImportReceipt, metal: ReadonlySet<number>): MetalsSkeletonLine[] {
  const skeleton: MetalsSkeletonLine[] = receipt.lines.map((line) => ({
    ordinal: line.ordinal,
    kind: line.kind === 'fee' ? 'fee' : 'item',
    amountMinor: line.amountMinor,
    shippingMinor: line.shippingMinor,
    feeParent: line.kind === 'fee' ? line.feeParent : null,
    couponTarget: null,
    taxFlag: null,
    metal: metal.has(line.kind === 'fee' ? line.feeParent! : line.ordinal),
  }));
  const fees = receipt.totals.feesMinor ?? 0;
  if (fees !== 0) {
    skeleton.push({
      ordinal: skeleton.length, kind: 'fee', amountMinor: fees, shippingMinor: null, feeParent: null, couponTarget: null, taxFlag: null,
      metal: false,
    });
  }
  return skeleton;
}

/** A receipt's skeleton: its lines as printed, a coupon metal exactly when the line it discounts is. */
function warehouseSkeleton(receipt: RetailImportReceipt, metal: ReadonlySet<number>): MetalsSkeletonLine[] {
  return receipt.lines.map((line) => ({
    ordinal: line.ordinal,
    kind: line.kind,
    amountMinor: line.amountMinor,
    shippingMinor: null,
    feeParent: null,
    couponTarget: line.kind === 'coupon' ? line.couponTarget : null,
    taxFlag: taxFlagOf(line.taxFlag),
    metal: line.kind === 'coupon' ? line.couponTarget !== null && metal.has(line.couponTarget) : metal.has(line.ordinal),
  }));
}

const EVENT_KINDS = ['shipped', 'delivered', 'cancelled', 'returned'] as const;

/** An online metal line's events as stated, numbered by occurrence in the source's own order; none before the order. */
function onlineEvents(line: RetailImportLine, quantity: number, orderDate: string): MetalsEvent[] {
  const stated = line.events ?? { shipped: [], delivered: [], cancelled: [], returned: [] };
  const occurrences = new Map<string, number>();
  const events: MetalsEvent[] = [];
  for (const kind of EVENT_KINDS) {
    for (const event of stated[kind]) {
      const identity = `${kind}\u0000${event.date}\u0000${event.quantity}`;
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      events.push({ kind, date: event.date, dateBasis: 'stated', quantity: event.quantity, occurrence });
    }
  }
  if (events.length > METALS_MAX_EVENTS) throw new Hold('event-count');
  const units = (kind: (typeof EVENT_KINDS)[number]) => unitsOf(stated[kind]);
  if (events.some((event) => event.quantity > quantity) || units('cancelled') + units('delivered') > quantity
    || units('returned') > units('delivered')) {
    throw new Hold('event-units');
  }
  if (events.some((event) => event.date !== null && event.date < orderDate)) throw new Hold('event-before-order');
  return events;
}

/** A warehouse line's title: its two printed lines joined while that is still stored text, else the first of them. */
function warehouseTitle(first: string | null, second: string | null): string | null {
  const parts = [first, second].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const joined = parts.join(' ');
  return cardImportTextProblem(joined, METALS_TITLE_MAX) === null ? joined : parts[0];
}

/**
 * The unit price as stated, kept only when the quantity times it is the line's amount, on both channels; otherwise
 * null (a cancelled online line priced at zero, a warehouse line whose printed price and amount differ). The amount is
 * always kept as stated.
 */
function unitPriceOf(line: RetailImportLine, quantity: number): number | null {
  const price = line.unitPriceMinor;
  if (price === null || price < 0 || price > METALS_MAX_MINOR) return null;
  return price * quantity === line.amountMinor ? price : null;
}

function lotOf(
  receipt: RetailImportReceipt, line: RetailImportLine, channel: MetalsChannel, allocation: MetalsAllocation,
): { lot: MetalsLine; titleWithheld: MetalsCostcoTitleWithheld | null } {
  const quantity = line.quantity;
  if (quantity === null || quantity < 1) throw new Hold('metal-quantity');
  if (line.amountMinor < 0) throw new Hold('metal-amount');
  // A flagged line has no metal evidence, so no form, mass or pack of its own: its pack is `unknown`.
  const evidence = line.metal;
  const pack: MetalPack = evidence?.pack ?? 'unknown';
  const stored = channel === 'online' ? line.title : warehouseTitle(line.title, line.title2);
  if (pack === 'single' && stored !== null && retailMetalPack(stored) === 'multiple') throw new Hold('pack-title');
  // Last, on the final stored title: an unflagged line's title the guard reads as metal-uncertain is withheld (1E).
  const titleWithheld = line.metalUncertain === null && stored !== null && retailMetalTitleGuard(stored, { assessed: true }).uncertain
    ? 'metal-guard' : null;
  const title = titleWithheld === null ? stored : null;
  const weight = evidence?.statedWeight ?? null;
  const content: MetalsContentEvidence = {
    source: 'costco',
    metal: evidence?.metal ?? null,
    form: evidence?.form ?? null,
    statedMass: weight === null ? null : { value: weight.value, unit: weight.unit },
    pack,
    purity: null,
    massBasis: null,
    design: null,
    metalUncertain: line.metalUncertain === null ? null : flagOf(line.metalUncertain),
  };
  const money = allocation.lines.find((entry) => entry.ordinal === line.ordinal)!;
  const events: MetalsEvent[] = channel === 'online'
    ? onlineEvents(line, quantity, receipt.date)
    : [{ kind: 'delivered', date: receipt.date, dateBasis: 'in-store', quantity, occurrence: 1 }];
  const lot: MetalsLine = {
    key: channel === 'online' ? line.lineKey! : metalsNaturalKey('costco', 'wline', [receipt.naturalKey, String(line.ordinal)]),
    ordinal: line.ordinal,
    title,
    productRef: line.itemNumber === null ? null : `costco:${line.itemNumber}`,
    metal: content.metal,
    metalUncertain: content.metalUncertain,
    form: content.form,
    statedMass: content.statedMass,
    pack,
    purity: null,
    massBasis: null,
    design: null,
    contentFingerprint: metalsContentFingerprint(content),
    fine: metalsFineContentWire(metalsFineContent(content)),
    quantity,
    unitPriceMinor: unitPriceOf(line, quantity),
    amountMinor: line.amountMinor,
    directMinor: money.directMinor,
    allocated: money.allocated,
    costMinor: money.totalMinor,
    netMinor: null,
    complete: money.complete,
    events,
    seller: null,
    sale: null,
  };
  return { lot, titleWithheld };
}

/** An online order's stated status against its lines' events: a status the events don't carry is ambiguous (§4.3). */
function checkOnlineStatus(receipt: RetailImportReceipt, lots: ReadonlySet<number>): void {
  if (receipt.status === 'returned' && !receipt.lines.some((line) => unitsOf(line.events?.returned) > 0)) throw new Hold('return-unstated');
  if (receipt.status === 'cancelled'
    && receipt.lines.some((line) => lots.has(line.ordinal) && unitsOf(line.events?.cancelled) < (line.quantity ?? 0))) {
    throw new Hold('cancel-unstated');
  }
}

function orderOf(receipt: RetailImportReceipt, channel: MetalsChannel, facts: MetalsAdmissionFacts): { order: MetalsOrder; titlesWithheld: number } {
  // The lot lines, flagged ones included: their skeleton lines are metal (a flagged one provisionally bullion).
  const lots = new Set(receipt.lines.filter(isLotLine).map((line) => line.ordinal));
  const skeleton = channel === 'online' ? onlineSkeleton(receipt, lots) : warehouseSkeleton(receipt, lots);
  if (skeleton.length > METALS_MAX_LINES) throw new Hold('skeleton-size');
  if (metalsSkeletonProblem(skeleton) !== null) throw new Hold('skeleton-shape');
  const totals = receipt.totals;
  const components = componentsOf(totals.taxMinor ?? 0, channel === 'online' ? (totals.discountMinor ?? 0) : 0);
  const allocation = metalsAllocation(skeleton, components);
  if (allocation.fullPriceMinor !== facts.grossTotalMinor) throw new Hold('full-price');
  if (channel === 'online') checkOnlineStatus(receipt, lots);
  const built = receipt.lines.filter((line) => lots.has(line.ordinal)).map((line) => lotOf(receipt, line, channel, allocation));
  const lines = built.map((entry) => entry.lot);
  // An order with a flagged line has no card evidence, whatever its funding would admit (contract follow-up 1).
  const flagged = lines.some((line) => line.metalUncertain !== null);
  const order: MetalsOrder = {
    key: receipt.naturalKey,
    side: 'buy',
    channel,
    date: receipt.date,
    tradeMoment: null,
    completedDate: null,
    currency: 'USD',
    status: null,
    skeleton,
    components,
    admission: facts,
    evidence: flagged ? [] : (metalsAdmission('costco', channel, facts)?.evidence ?? []),
    refunds: [],
    payouts: [],
    unattributedMinor: allocation.unattributedMinor,
    fullPriceMinor: allocation.fullPriceMinor,
    lines,
  };
  return { order, titlesWithheld: built.filter((entry) => entry.titleWithheld !== null).length };
}

type Converted =
  | { kind: 'order'; order: MetalsOrder; titlesWithheld: number }
  | { kind: 'competitor'; competitor: MetalsCompetitor }
  | { kind: 'held'; held: MetalsHeldRecord }
  | { kind: 'credit' }
  | { kind: 'none' };

/**
 * One retail record: an order (it has a lot line), a competitor (card funding only), held, a credit, or neither. A
 * refund receipt is a credit: it funds no order, so it is no competitor (a card row it explains is never a purchase),
 * and one with a lot line is held whole as an unresolved return. A flag or metal evidence on a line that can't be a
 * lot holds the whole record, whatever else it is.
 */
function convertRecord(receipt: RetailImportReceipt): Converted {
  const channel = channelOf(receipt);
  try {
    if (receipt.lines.some(isFlagOffLot)) throw new Hold('flag-not-item');
    if (receipt.lines.some(isMetalOffLot)) throw new Hold('metal-not-item');
    const lot = receipt.lines.some(isLotLine);
    if (receipt.sign === 'refund') {
      if (lot) throw new Hold('refund-receipt-metal');
      return { kind: 'credit' };
    }
    const facts = admissionOf(receipt, channel);
    const wrongSign = facts.methods.some((method) => method.amountMinor !== null
      && (method.kind === 'card-refund' ? method.amountMinor >= 0 : method.amountMinor < 0));
    if (!lot) {
      const admitted = metalsAdmission('costco', channel, facts);
      if (admitted === null) return { kind: 'none' };
      if (wrongSign) throw new Hold('method-sign');
      return {
        kind: 'competitor',
        competitor: {
          orderKey: receipt.naturalKey,
          channel,
          date: receipt.date,
          interval: metalsSettlementInterval(receipt.date, channel),
          admission: facts,
          basis: admitted.basis,
          capMinor: admitted.capMinor,
        },
      };
    }
    if (wrongSign) throw new Hold('method-sign');
    return { kind: 'order', ...orderOf(receipt, channel, facts) };
  } catch (error) {
    if (!(error instanceof Hold)) throw error;
    return {
      kind: 'held',
      held: { key: receipt.naturalKey, channel, date: receipt.date, reason: METALS_COSTCO_HOLD_CHECKS[error.check], check: error.check },
    };
  }
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function coverageOf(retail: RetailImportPayload): MetalsCoverage[] {
  const ranges = (kind: 'online' | 'warehouse') => retail.coverage[kind].map((range): MetalsCoverage => ({
    kind, from: range.from, to: range.to, stated: range.stated, seen: range.seen, complete: range.stated !== null && range.stated === range.seen,
  }));
  return [...ranges('online'), ...ranges('warehouse')];
}

/** The census's retail side: the input's metal and flagged lines, and those in the records the adapter held. */
interface RetailCensus {
  retailMetalLines: number;
  metalLinesInHeldRecords: number;
  retailFlaggedLines: number;
  flaggedLinesInHeldRecords: number;
  heldMetalWordLines: number;
  heldAlsoFlaggedOrders: number;
}

function reportOf(
  source: MetalsCostcoRetailSource,
  payload: MetalsImportPayload,
  counts: { credits: number; noCardFunding: number; retailHeld: number; gasCompetitors: number; census: RetailCensus; titlesWithheld: number },
): MetalsCostcoConvertReport {
  const { retail } = source;
  const lots = payload.orders.flatMap((order) => order.lines.map((line) => ({ channel: order.channel, line })));
  const questions = metalsOwnerQuestionCounts(payload.orders);
  const adapterHeld = payload.held.length - counts.retailHeld;
  const byReason = zeroes(METALS_HOLD_REASONS);
  const byCheck: Record<string, number> = {};
  for (const held of payload.held) {
    byReason[held.reason] += 1;
    byCheck[held.check] = (byCheck[held.check] ?? 0) + 1;
  }
  const report: MetalsCostcoConvertReport = {
    converter: source.converterVersion,
    source: 'costco',
    folder: retail.membership.folder,
    membershipIdentity: retail.membership.membershipLast4 === null ? 'none' : 'stated',
    retail: { format: METALS_COSTCO_RETAIL_FORMAT, policyVersion: METALS_COSTCO_RETAIL_POLICY, records: retail.receipts.length, held: retail.held.length },
    records: {
      orders: payload.orders.length, competitors: payload.competitors.length, held: adapterHeld, credits: counts.credits,
      noCardFunding: counts.noCardFunding,
    },
    orders: {
      online: payload.orders.filter((order) => order.channel === 'online').length,
      warehouse: payload.orders.filter((order) => order.channel === 'warehouse').length,
    },
    lots: {
      online: lots.filter((lot) => lot.channel === 'online').length,
      warehouse: lots.filter((lot) => lot.channel === 'warehouse').length,
      byMetal: zeroes([...METALS, 'none'] as const),
      byForm: zeroes([...METAL_FORMS, 'none'] as const),
      byPack: zeroes(METAL_PACKS),
      withWeight: 0,
      costComplete: 0,
      byContentHold: zeroes(METALS_CONTENT_HOLDS),
      flagged: 0,
      flaggedByMetal: zeroes([...METALS, 'none'] as const),
      titlesWithheldBy: { 'metal-guard': counts.titlesWithheld },
    },
    confirmations: questions.confirmations,
    bullion: questions.bullion,
    evidence: { online: 0, warehouse: 0 },
    competitors: {
      online: payload.competitors.filter((competitor) => competitor.channel === 'online').length,
      warehouse: payload.competitors.filter((competitor) => competitor.channel === 'warehouse').length,
      fromGas: counts.gasCompetitors,
      singleCharge: payload.competitors.filter((competitor) => competitor.basis === 'single-charge').length,
      aggregate: payload.competitors.filter((competitor) => competitor.basis === 'aggregate').length,
    },
    held: { retail: counts.retailHeld, adapter: adapterHeld, byReason, byCheck: Object.fromEntries(Object.entries(byCheck).sort()) },
    census: {
      retailMetalLines: counts.census.retailMetalLines,
      metalLinesInOrders: 0,
      metalLinesInHeldRecords: counts.census.metalLinesInHeldRecords,
      retailFlaggedLines: counts.census.retailFlaggedLines,
      flaggedLinesInOrders: 0,
      flaggedLinesInHeldRecords: counts.census.flaggedLinesInHeldRecords,
      heldMetalWordLines: counts.census.heldMetalWordLines,
      heldAlsoFlaggedOrders: counts.census.heldAlsoFlaggedOrders,
    },
    coverage: {
      online: payload.coverage.filter((range) => range.kind === 'online').length,
      warehouse: payload.coverage.filter((range) => range.kind === 'warehouse').length,
      complete: payload.coverage.filter((range) => range.complete).length,
    },
    dates: { first: null, last: null },
  };
  for (const { line } of lots) {
    report.lots.byMetal[line.metal ?? 'none'] += 1;
    report.lots.byForm[line.form ?? 'none'] += 1;
    report.lots.byPack[line.pack] += 1;
    if (line.statedMass !== null) report.lots.withWeight += 1;
    if (line.complete) report.lots.costComplete += 1;
    if ('hold' in line.fine) report.lots.byContentHold[line.fine.hold] += 1;
    if (line.metalUncertain !== null) {
      report.lots.flagged += 1;
      report.lots.flaggedByMetal[line.metalUncertain.metal ?? 'none'] += 1;
      report.census.flaggedLinesInOrders += 1;
    } else {
      report.census.metalLinesInOrders += 1;
    }
  }
  for (const order of payload.orders) report.evidence[order.channel] += order.evidence.length;
  for (const receipt of retail.receipts) {
    if (report.dates.first === null || receipt.date < report.dates.first) report.dates.first = receipt.date;
    if (report.dates.last === null || receipt.date > report.dates.last) report.dates.last = receipt.date;
  }
  return report;
}

/**
 * Converts a retail payload the retail validator accepted (convertCostcoRetailPayload validates it first). A record
 * that doesn't fit the ledger is held with its reason; the payload is validated before it is returned.
 */
export function costcoMetalsFromRetail(source: MetalsCostcoRetailSource): MetalsCostcoConvertResult {
  const { retail } = source;
  if (!CONVERTER_VERSION.test(source.converterVersion)) throw new MetalsConvertError('converter-version');
  if (!LETTER_HEX.test(source.retailPayloadSha256)) throw new MetalsConvertError('retail-invalid');
  if ((retail.version as number) !== METALS_COSTCO_RETAIL_FORMAT || (retail.policyVersion as number) !== METALS_COSTCO_RETAIL_POLICY) {
    throw new MetalsConvertError('retail-policy-unsupported', '$.policyVersion');
  }
  retail.receipts.forEach((receipt, index) => receipt.lines.forEach((line, at) => {
    if (line.metal !== null && line.metal.rule !== METALS_RULES.title) {
      throw new MetalsConvertError('retail-policy-unsupported', `$.receipts[${index}].lines[${at}].metal.rule`);
    }
    if (line.metalUncertain !== null && line.metalUncertain.guard !== METALS_TITLE_GUARD) {
      throw new MetalsConvertError('retail-policy-unsupported', `$.receipts[${index}].lines[${at}].metalUncertain.guard`);
    }
  }));

  const orders: MetalsOrder[] = [];
  const competitors: MetalsCompetitor[] = [];
  const held: MetalsHeldRecord[] = [];
  let credits = 0;
  let noCardFunding = 0;
  let gasCompetitors = 0;
  let titlesWithheld = 0;
  const census: RetailCensus = {
    retailMetalLines: 0, metalLinesInHeldRecords: 0, retailFlaggedLines: 0, flaggedLinesInHeldRecords: 0, heldMetalWordLines: 0,
    heldAlsoFlaggedOrders: 0,
  };
  for (const receipt of retail.receipts) {
    const metalLines = receipt.lines.filter((line) => line.metal !== null).length;
    const flaggedLines = receipt.lines.filter((line) => line.metalUncertain !== null).length;
    census.retailMetalLines += metalLines;
    census.retailFlaggedLines += flaggedLines;
    const converted = convertRecord(receipt);
    if (converted.kind === 'order') {
      orders.push(converted.order);
      titlesWithheld += converted.titlesWithheld;
    } else if (converted.kind === 'competitor') {
      competitors.push(converted.competitor);
      if (receipt.channel === 'gas') gasCompetitors += 1;
    } else if (converted.kind === 'held') {
      held.push(converted.held);
      census.metalLinesInHeldRecords += metalLines;
      census.flaggedLinesInHeldRecords += flaggedLines;
      census.heldMetalWordLines += receipt.lines.filter((line) => line.metal !== null || line.metalUncertain !== null).length;
      if (flaggedLines > 0) census.heldAlsoFlaggedOrders += 1;
    } else if (converted.kind === 'credit') credits += 1;
    else noCardFunding += 1;
  }
  for (const record of retail.held) {
    held.push({
      key: record.naturalKey,
      channel: record.channel === 'online' ? 'online' : 'warehouse',
      date: record.date,
      reason: 'retail-held',
      check: record.check,
    });
  }
  orders.sort((a, b) => compare(a.date, b.date) || compare(a.channel, b.channel) || compare(a.key, b.key));
  competitors.sort((a, b) => compare(a.date, b.date) || compare(a.channel, b.channel) || compare(a.orderKey, b.orderKey));
  held.sort((a, b) => compare(a.channel, b.channel) || compare(a.reason, b.reason) || compare(a.check, b.check)
    || compare(a.key ?? '', b.key ?? '') || compare(a.date ?? '', b.date ?? ''));

  const payload: MetalsImportPayload = {
    format: METALS_IMPORT_FORMAT,
    version: METALS_IMPORT_VERSION,
    source: 'costco',
    account: { folder: retail.membership.folder, identityLast4: retail.membership.membershipLast4 },
    converterVersion: source.converterVersion,
    policyVersion: METALS_CONVERT_POLICY_VERSION,
    rules: { ...METALS_RULES },
    input: { retailPayloadSha256: source.retailPayloadSha256, retailFormat: METALS_COSTCO_RETAIL_FORMAT, retailPolicyVersion: METALS_COSTCO_RETAIL_POLICY },
    coverage: coverageOf(retail),
    orders,
    competitors,
    held,
  };
  return metalsConvertOutput(payload, reportOf(source, payload, { credits, noCardFunding, retailHeld: retail.held.length, gasCompetitors, census, titlesWithheld }));
}

/**
 * `holdr-metals-convert --source costco`: one retail payload file's bytes to one metals payload. The file must be a
 * Costco `holdr.retail-import` of policy 5 (format 3) that the retail validator accepts; anything else is refused,
 * and nothing of it is converted.
 */
export function convertCostcoRetailPayload(file: MetalsRetailPayloadFile): MetalsCostcoConvertResult {
  if (!CONVERTER_VERSION.test(file.converterVersion)) throw new MetalsConvertError('converter-version');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes));
  } catch {
    throw new MetalsConvertError('retail-unreadable');
  }
  if (!isRecord(parsed) || parsed.format !== RETAIL_IMPORT_FORMAT) throw new MetalsConvertError('retail-invalid', '$.format');
  if (parsed.merchant !== 'costco') throw new MetalsConvertError('retail-invalid', '$.merchant');
  if (parsed.version !== METALS_COSTCO_RETAIL_FORMAT || parsed.policyVersion !== METALS_COSTCO_RETAIL_POLICY) {
    throw new MetalsConvertError('retail-policy-unsupported', '$.policyVersion');
  }
  const checked = validateRetailImportPayload(parsed);
  if (!checked.ok) throw new MetalsConvertError('retail-invalid', checked.issues[0]?.path);
  return costcoMetalsFromRetail({ retail: checked.payload, retailPayloadSha256: metalsDigest(file.bytes), converterVersion: file.converterVersion });
}

/** The CLI registry's entry for `--source costco --retail-payload FILE`. */
export const METALS_COSTCO_CONVERTER: MetalsRetailPayloadConverter = {
  input: 'retail-payload',
  source: 'costco',
  convert: convertCostcoRetailPayload,
};
