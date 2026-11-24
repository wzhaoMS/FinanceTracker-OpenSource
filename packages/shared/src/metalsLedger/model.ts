/**
 * The metals ledger's shared vocabulary (design v8 §4–§5): the closed lists, rule labels and record shapes that the
 * content and allocation rules, the `holdr.metals-import` v1 payload and its validator share. Every list is closed;
 * a change to one is a new version of the rule or payload that names it. Pure constants and types only.
 *
 * Value-free by construction: keys are one-way letter hex, product refs are public catalog ids, and the only digits a
 * payload may carry about a person's money are typed last-4 fields and amounts.
 */

import {
  RETAIL_METAL_FORMS,
  RETAIL_METAL_GUARD,
  RETAIL_METAL_GUARD_EVIDENCE,
  RETAIL_METALS,
  RETAIL_WEIGHT_UNITS,
  type RetailMetal,
  type RetailMetalForm,
  type RetailMetalGuard,
  type RetailMetalGuardEvidence,
  type RetailWeightUnit,
} from '../retailImportTool/metalTitleRule.js';
import { RETAIL_METAL_PACK_RULE, RETAIL_METAL_PACKS, type RetailMetalPack } from '../retailImportTool/metalPackRule.js';

export const METALS_IMPORT_FORMAT = 'holdr.metals-import' as const;
export const METALS_IMPORT_VERSION = 1 as const;
/** The version of the converters' shared policy: which facts a payload carries and how they are derived. */
export const METALS_CONVERT_POLICY_VERSION = 1 as const;
/**
 * The converters' one release, and the only one a payload may name: it marks an importable release, where every
 * producer writes the rules METALS_RULES names. 1.1.0 (contract follow-up 1E) is the release where every producer runs
 * the title guard. Pinned in model.test.ts; the converters (converters/common.ts) and the CLI read it from here.
 */
export const METALS_CONVERTER_VERSION = '1.1.0' as const;
/** What every payload names in `converterVersion`, and what `holdr-metals-convert --version` prints. */
export const METALS_CONVERTER = `holdr-metals-convert ${METALS_CONVERTER_VERSION}` as const;

/** The rule versions a payload names, each pinned: a change to any rule is a new version of it. */
export const METALS_RULES = {
  // Pinned. model.test.ts keeps it equal to the retail tool's RETAIL_METAL_TITLE_RULE, so a payload is never computed
  // under one title rule and labelled with another (retail policy 5).
  title: 'title-rule-v3',
  // The title guard every producer runs on each line's raw title: the retail tool's own RETAIL_METAL_GUARD, imported
  // (one source) and pinned in model.test.ts. A payload names it only once every producer runs it (contract
  // follow-up 1E), and the validator then runs it on each unflagged line's stored title (payload.ts).
  titleGuard: RETAIL_METAL_GUARD,
  pack: RETAIL_METAL_PACK_RULE,
  content: 'metals-content-v2',
  coinSpecs: 'metals-coin-specs-v1',
  allocation: 'metals-allocation-v1',
} as const;
export type MetalsRules = typeof METALS_RULES;

export const METALS_SOURCES = ['costco', 'walmart', 'collectpure'] as const;
export type MetalsSource = (typeof METALS_SOURCES)[number];
export const METALS_SIDES = ['buy', 'sell'] as const;
export type MetalsSide = (typeof METALS_SIDES)[number];
/** An order's channel: Costco online or warehouse; Walmart and CollectPure are online. */
export const METALS_CHANNELS = ['online', 'warehouse'] as const;
export type MetalsChannel = (typeof METALS_CHANNELS)[number];

export const METALS = RETAIL_METALS;
export type Metal = RetailMetal;
export const METAL_FORMS = RETAIL_METAL_FORMS;
export type MetalForm = RetailMetalForm;
export const METAL_MASS_UNITS = RETAIL_WEIGHT_UNITS;
export type MetalMassUnit = RetailWeightUnit;
export const METAL_PACKS = RETAIL_METAL_PACKS;
export type MetalPack = RetailMetalPack;

/** A stated mass exactly as the title rule read it: the number as written and its unit (a bare `oz` stays `oz`). */
export interface MetalsStatedMass {
  value: string;
  unit: MetalMassUnit;
}

/**
 * How a title qualifies its stated mass (§4.4.1 step 5): `gross` (the piece's weight), `fine` (its metal content),
 * `approximate` (a minimum or an approximation), `conflict` (both gross and fine), `none` (exact and unqualified), or
 * `unknown` (the raw text could not be read in full: a character outside the closed alphabet, or a cut or masked
 * title), which, like `conflict`, only ever holds.
 */
export const METALS_MASS_BASES = ['gross', 'fine', 'approximate', 'conflict', 'none', 'unknown'] as const;
export type MetalsMassBasis = (typeof METALS_MASS_BASES)[number];

/** A stated purity, as written in the closed grammar, with its exact value as "n/d" in lowest terms. */
export interface MetalsPurity {
  text: string;
  value: string;
}

/** The coin designs the title rule recognizes (a design word right after a metal word, or a coin's own name). */
export const METALS_COIN_DESIGNS = [
  'eagle', 'maple-leaf', 'buffalo', 'kangaroo', 'panda', 'krugerrand', 'britannia', 'philharmonic',
] as const;
export type MetalsCoinDesign = (typeof METALS_COIN_DESIGNS)[number];

/** Who vouches for a unit's fine content (§4.4.1 step 6), in order of precedence. */
export const METALS_FINE_BASES = ['owner-confirmed', 'coin-specification', 'stated-mass-basis'] as const;
export type MetalsFineBasis = (typeof METALS_FINE_BASES)[number];

/** Why a unit's fine content is not known, each a step of §4.4.1 that lacked an answer. */
export const METALS_CONTENT_HOLDS = [
  'metal-unknown',
  'pack-count',
  'pack-unproven',
  'weight-unstated',
  'unit-unconfirmed',
  'mass-basis-unknown',
  'fine-content-unknown',
  'confirmation-drift',
  'bullion-unconfirmed',
] as const;
export type MetalsContentHold = (typeof METALS_CONTENT_HOLDS)[number];

/** Fine content per ordered unit, exact: troy ounces as "n/d" with its authority, or a hold naming every step missing. */
export type MetalsFineContent =
  | { troyOz: string; basis: MetalsFineBasis }
  | { hold: MetalsContentHold; missing: MetalsContentHold[] };

/**
 * The title guard a flagged line names: the retail tool's `RETAIL_METAL_GUARD` (retail policy 5), the guard that sets
 * the flag. A line the title rule reads as no metal, whose raw title names a metal as a whole word and shows bullion
 * evidence, is metal-uncertain: never silently no metal. The guard and its evidence order are part of a flagged line's
 * content fingerprint, so model.test.ts pins both: changing either is a new content rule.
 */
export const METALS_TITLE_GUARD = RETAIL_METAL_GUARD;
export type MetalsTitleGuard = RetailMetalGuard;

/** The bullion evidence the guard reads, in its closed order: the retail tool's `RETAIL_METAL_GUARD_EVIDENCE`. */
export const METALS_GUARD_EVIDENCE = RETAIL_METAL_GUARD_EVIDENCE;
export type MetalsGuardEvidence = RetailMetalGuardEvidence;

/**
 * A metal-uncertain line's flag, in retail format 3's shape (`RetailLineMetalUncertain`, same fields in the same order;
 * model.test.ts checks each assigns to the other): the guard; every evidence code that fired, once each, in the closed
 * order; and the one metal the title's whole-word metal words name (null when they name several). Only a line whose
 * title reads as no metal carries one. Read by the converter on the raw title, like `pack`, and checked by value only.
 * A decision never names the metal: once the owner decides the line is bullion, it is a line of this metal.
 */
export interface MetalsLineMetalUncertain {
  guard: MetalsTitleGuard;
  evidence: MetalsGuardEvidence[];
  metal: Metal | null;
}

/**
 * The owner's answer for a line the title guard flagged (design 4b): `bullion` releases its content hold, so the usual
 * authorities apply to it as a line of its flag's metal; `not-bullion` is the read side's to apply (its line is no metal
 * there). Append-only and versioned like content decisions; never names the metal.
 */
export const METALS_BULLION_ANSWERS = ['bullion', 'not-bullion'] as const;
export type MetalsBullionAnswer = (typeof METALS_BULLION_ANSWERS)[number];

// ---------------------------------------------------------------------------
// Money: the anonymous accounting skeleton (§4.4.2)
// ---------------------------------------------------------------------------

export const METALS_SKELETON_KINDS = ['item', 'fee', 'coupon', 'fuel'] as const;
export type MetalsSkeletonKind = (typeof METALS_SKELETON_KINDS)[number];
/** A line's tax flag as stated, normalized: taxable, not taxable, or not stated (null). */
export const METALS_TAX_FLAGS = ['taxable', 'non-taxable'] as const;
export type MetalsTaxFlag = (typeof METALS_TAX_FLAGS)[number];

/** One money line of an order, with no title or item number: what the allocation rule needs and nothing else. */
export interface MetalsSkeletonLine {
  /** Position in the order, 0 first, contiguous. */
  ordinal: number;
  kind: MetalsSkeletonKind;
  amountMinor: number;
  /** The line's own shipping, when the source states it per line. */
  shippingMinor: number | null;
  /** A fee line: the ordinal of its parent line, or null for an order-level fee. */
  feeParent: number | null;
  /** A coupon line: the ordinal of the line it discounts, or null for an order-level discount. */
  couponTarget: number | null;
  taxFlag: MetalsTaxFlag | null;
  metal: boolean;
}

/**
 * An order-level money component the source does not state per line, signed as it moves the order's price (a discount
 * is negative); on a sale, the dealer's deductions are negative.
 */
export const METALS_COMPONENT_KINDS = ['tax', 'shipping', 'discount', 'platform-fee', 'insured-shipping'] as const;
export type MetalsComponentKind = (typeof METALS_COMPONENT_KINDS)[number];
export interface MetalsOrderComponent {
  kind: MetalsComponentKind;
  amountMinor: number;
}

/** One allocated share on a line: the component it came from ("tax", "fee@3" for skeleton line 3, …) and its cents. */
export interface MetalsAllocatedShare {
  component: string;
  amountMinor: number;
}

// ---------------------------------------------------------------------------
// Funding: tenders, admission facts and card evidence (§4.1, §4.4.4)
// ---------------------------------------------------------------------------

export const METALS_TENDER_KINDS = [
  'card', 'card-refund', 'shop-card', 'gift-card', 'store-balance', 'paypal', 'debit', 'cash', 'reward-certificate',
  'coupon',
] as const;
export type MetalsTenderKind = (typeof METALS_TENDER_KINDS)[number];
/** Tenders that carry a card's last 4 and can be card evidence. */
export const METALS_CARD_TENDER_KINDS: readonly MetalsTenderKind[] = ['card', 'card-refund'];
export const METALS_NETWORKS = ['visa', 'mastercard', 'amex', 'discover', 'unknown'] as const;
export type MetalsNetwork = (typeof METALS_NETWORKS)[number];

/** One payment method of an order: its kind, network, last 4 (cards only) and stated amount, or null when unstated. */
export interface MetalsTender {
  kind: MetalsTenderKind;
  network: MetalsNetwork;
  last4: string | null;
  amountMinor: number | null;
}

/**
 * The facts that decide whether an order's card funding settles in one charge (§4.4.4), carried on every buy order
 * and every competitor so that the validator and the importer recompute evidence, basis and cap from them.
 * `shipments` counts shipment records (Costco) or shipment groups (Walmart) order-wide, null when the source gives
 * none; it is never a count of event dates.
 */
export interface MetalsAdmissionFacts {
  fulfilment: 'in-store' | { shipments: number | null };
  methods: MetalsTender[];
  refunded: boolean;
  cancelled: boolean;
  partlyCancelled: boolean;
  /** The order's full price before any refund, never negative, or null when unknown. */
  grossTotalMinor: number | null;
}

export const METALS_EVIDENCE_CLASSES = ['costco-settled-tender@1', 'walmart-order-total@1'] as const;
export type MetalsEvidenceClass = (typeof METALS_EVIDENCE_CLASSES)[number];
/** An amount a named, versioned evidence class says went to one card method (by its index in `methods`). */
export interface MetalsCardEvidence {
  class: MetalsEvidenceClass;
  tender: number;
  amountMinor: number;
}

export const METALS_COMPETITOR_BASES = ['single-charge', 'aggregate'] as const;
export type MetalsCompetitorBasis = (typeof METALS_COMPETITOR_BASES)[number];

/** Card-row windows by channel, in days after the order date, both ends inclusive (§4.4.4). */
export const METALS_SETTLEMENT_WINDOW_DAYS: Readonly<Record<MetalsChannel, number>> = { online: 30, warehouse: 5 };

// ---------------------------------------------------------------------------
// Lifecycle (§4.3)
// ---------------------------------------------------------------------------

export const METALS_EVENT_KINDS = [
  'shipped', 'delivered', 'cancelled', 'returned', 'agreed', 'received', 'inspected', 'completed',
] as const;
export type MetalsEventKind = (typeof METALS_EVENT_KINDS)[number];
/** Buy-side and sell-side event kinds: a lot never carries a sale's steps, nor a sale a lot's. */
export const METALS_BUY_EVENT_KINDS: readonly MetalsEventKind[] = ['shipped', 'delivered', 'cancelled', 'returned'];
export const METALS_SELL_EVENT_KINDS: readonly MetalsEventKind[] = ['agreed', 'shipped', 'received', 'inspected', 'completed', 'cancelled'];
export const METALS_DATE_BASES = ['stated', 'year-inferred', 'in-store'] as const;
export type MetalsDateBasis = (typeof METALS_DATE_BASES)[number];

/**
 * An event: (line, kind, date or null, quantity, occurrence). `occurrence` numbers identical (kind, date, quantity)
 * events in the source's own order within one observation, from 1.
 */
export interface MetalsEvent {
  kind: MetalsEventKind;
  date: string | null;
  dateBasis: MetalsDateBasis | null;
  quantity: number;
  occurrence: number;
}

export const METALS_PAYOUT_STATUSES = ['complete', 'pending', 'failed'] as const;
export type MetalsPayoutStatus = (typeof METALS_PAYOUT_STATUSES)[number];

/** A sale's lifecycle (§4.3): the dealer's steps mapped onto these, or cancelled. Buy orders carry no order status. */
export const METALS_SELL_STATUSES = ['agreed', 'shipped', 'received', 'inspected', 'complete', 'cancelled'] as const;
export type MetalsSellStatus = (typeof METALS_SELL_STATUSES)[number];
export const METALS_INSPECTIONS = ['passed', 'failed', 'pending'] as const;
export type MetalsInspection = (typeof METALS_INSPECTIONS)[number];
export const METALS_PREMIUM_BASES = ['troy_ounce', 'unit'] as const;
export type MetalsPremiumBasis = (typeof METALS_PREMIUM_BASES)[number];

/** The capture schemas the Walmart and CollectPure converters read; Costco's adapter reads a retail payload instead. */
export const METALS_CAPTURE_SCHEMAS = {
  walmart: 'holdr-retail-capture/walmart@1',
  collectpure: 'holdr-retail-capture/collectpure@1',
} as const;

export const METALS_COVERAGE_KINDS = ['online', 'warehouse', 'sell-orders', 'payouts'] as const;
export type MetalsCoverageKind = (typeof METALS_COVERAGE_KINDS)[number];

/** Why a captured record is held instead of converted. A held record keeps its key, channel and date, never a value. */
export const METALS_HOLD_REASONS = [
  'unreadable',
  'raw-missing',
  'capture-disagreement',
  'duplicate-in-capture',
  'currency-unsupported',
  'identity-failed',
  'field-unsupported',
  'field-missing',
  'status-unknown',
  'status-ambiguous',
  'quantity-unknown',
  'return-unlinked',
  'payout-unsupported',
  'inspection-failed',
  'buy-side-unsupported',
  'vault-unsupported',
  'retail-held',
] as const;
export type MetalsHoldReason = (typeof METALS_HOLD_REASONS)[number];
