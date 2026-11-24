import type { CardAccountStatus, CardOwner, CardTransactionKind } from '../types.js';

/**
 * Card benefits: what each card product gives back per period (statement
 * credits, Uber Cash, certificates), how much of it was used, and from what.
 * The catalog (catalog.ts) is Holdr's own, written from the issuers' public
 * benefit pages; the report (report.ts) combines it with the card
 * transactions Holdr already stores, the owner's manual marks and, when
 * present, the figures an issuer reports itself.
 */

export type BenefitIssuer = 'amex' | 'chase' | 'citi';

/**
 * How often a benefit resets. Calendar periods start in January (months,
 * quarters, Jan–Jun and Jul–Dec halves, years); cardmember periods start in
 * the card's anniversary month. `years` is a credit available once per
 * rolling window, such as a Global Entry fee every four years.
 */
export type BenefitCadence =
  | { every: 'month' | 'quarter' | 'half' | 'year'; basis: 'calendar' | 'cardmember' }
  | { every: 'years'; months: number };

/**
 * What one period gives: US dollars in cents, or a number of things (a free
 * night, a companion certificate, a quarterly activation) that has no dollar
 * figure Holdr could vouch for, so it is never added to dollar totals.
 */
export type BenefitValue =
  | {
    unit: 'usd';
    amountMinor: number;
    /** Exceptions by the month a period starts in (1–12), e.g. a larger December credit. */
    byStartMonth?: Readonly<Partial<Record<number, number>>>;
  }
  | { unit: 'count'; count: number; noun: string };

/** Why a benefit cannot be read off card transactions. */
export type BenefitManualReason =
  /** Loaded into the issuer partner's own app, never posted to the card (Uber Cash). */
  | 'partner-balance'
  /** A certificate in the loyalty account. */
  | 'certificate'
  /** A discount taken at checkout or booking (a promo code, a hotel benefit), never a separate credit. */
  | 'discount'
  /** Something to switch on each period (quarterly bonus categories). */
  | 'activation'
  /** Posted, but without wording Holdr can tell apart from other credits. */
  | 'not-itemized';

export type BenefitTracking =
  /**
   * Posted statement credits whose description or merchant matches one of
   * `patterns` (case-insensitive regex sources, which also say "credit");
   * `adjustmentPatterns` count only on `adjustment` rows, where an issuer
   * that files its credits under fees and adjustments (American Express)
   * sets them apart from merchant refunds, so the benefit's own name is enough.
   */
  | { method: 'statement-credit'; patterns: readonly string[]; adjustmentPatterns?: readonly string[] }
  | { method: 'manual'; reason: BenefitManualReason };

/**
 * One benefit of a product. A benefit that changed (amount, wording) keeps
 * its id: each version is listed with the dates it applied, and versions of
 * one id share a cadence and a unit, so marks and the yearly grid line up.
 */
export interface BenefitDefinition {
  /** Kebab-case, stable within the product. */
  id: string;
  name: string;
  kind: 'credit' | 'certificate' | 'activation';
  value: BenefitValue;
  cadence: BenefitCadence;
  /** The issuer requires enrolling before the benefit applies. */
  enrollment: boolean;
  tracking: BenefitTracking;
  /** First day this version applies (inclusive), when it started after the catalog's earliest year. */
  validFrom?: string;
  /** Last day this version applies (inclusive). */
  validUntil?: string;
  /** Amount, period or rules not confirmed on the issuer's own page: shown as unverified. */
  verify?: boolean;
  /** What counts, briefly. */
  note?: string;
  /** Issuer-native tracker ids that report this benefit (exact match only). */
  issuerTrackerIds?: readonly string[];
  /**
   * Display only: the name the Benefits area compares this benefit under
   * across cards (its By benefit view), where its own name would put it with
   * another program's benefit or apart from its own program's. Benefits of
   * different products with the same comparison name are one benefit there.
   * Versions of one id share it.
   */
  compareAs?: string;
  /** Display only: where the By benefit view lists it (BenefitCategory). Versions of one id share it. */
  category?: BenefitCategory;
}

/**
 * The sections the Benefits area's By benefit view lists benefits in, after
 * the categories card communities sort credits into: airlines and other
 * travel, hotels, dining, shopping and lifestyle, and business services.
 */
export type BenefitCategory = 'travel' | 'hotel' | 'dining' | 'shopping' | 'business';

export interface BenefitProduct {
  id: string;
  issuer: BenefitIssuer;
  name: string;
  shortName: string;
  /** Case-insensitive regex sources matched against a card account's nickname, for automatic mapping. */
  nicknamePatterns: readonly string[];
  /** Current annual fee in cents; null when the product has none. */
  annualFeeMinor: number | null;
  /** The fee was not confirmed on the issuer's own page. */
  feeVerify?: boolean;
  /** The issuer's public page the catalog entry follows. */
  sourceUrl: string;
  benefits: readonly BenefitDefinition[];
}

export interface BenefitCatalog {
  version: string;
  /** Within an issuer, more specific products come first: the first nickname match wins. */
  products: readonly BenefitProduct[];
}

/** How a card account's product was chosen: from its nickname, by the owner, or explicitly none. */
export type BenefitProductChoice = 'auto' | 'manual' | 'none';

export interface CardBenefitSettings {
  cardAccountId: string;
  productChoice: BenefitProductChoice;
  /** Set exactly when `productChoice` is `manual`. */
  productId: string | null;
  /** 1–12: the month the cardmember year starts, for anniversary-based benefits. */
  anniversaryMonth: number | null;
  updatedAt: string;
}

export type BenefitMarkStatus = 'used' | 'partial' | 'unused';

/** The owner's own word for one period of one benefit: fully used, partly used (an amount), or not used. */
export interface CardBenefitMark {
  cardAccountId: string;
  benefitId: string;
  /** The period's first day, as the report names it. */
  periodStart: string;
  status: BenefitMarkStatus;
  /** Set exactly when `status` is `partial`: cents, or a count for count benefits. */
  usedMinor: number | null;
  markedAt: string;
}

/** A stored card transaction as benefit matching reads it. */
export interface BenefitCreditRow {
  id: string;
  cardAccountId: string;
  /** Transaction date. */
  date: string;
  /** Holdr's sign: negative is money back. */
  amountMinor: number;
  kind: CardTransactionKind;
  description: string;
  merchant: string | null;
}

/** Where a period's used figure came from. */
export type BenefitFigureSource = 'issuer' | 'manual' | 'derived' | 'none';

export interface BenefitMatchView {
  id: string;
  date: string;
  amountMinor: number;
  description: string;
}

export interface BenefitIssuerFigure {
  issuerBenefitId: string;
  name: string;
  observedAt: string;
  /** Observed more than ISSUER_TRACKER_STALE_DAYS before today. */
  stale: boolean;
  usedMinor: number | null;
  totalMinor: number | null;
  enrollment: 'enrolled' | 'not-enrolled' | 'not-required' | 'unknown';
  resetDate: string | null;
}

export interface BenefitPeriodView {
  start: string;
  end: string;
  label: string;
  state: 'past' | 'current' | 'future';
  /** False for a period the benefit did not exist in (before or after its versions). */
  active: boolean;
  /** Cents (usd) or a count; 0 when inactive. */
  availableMinor: number;
  /** Null when unknown: a manual benefit without a mark, or an issuer figure that says unknown. */
  usedMinor: number | null;
  source: BenefitFigureSource;
  /** What the matched credits add up to, capped at the period's amount. */
  derivedMinor: number;
  matches: BenefitMatchView[];
  mark: { status: BenefitMarkStatus; usedMinor: number | null; markedAt: string } | null;
  issuer: BenefitIssuerFigure | null;
}

export interface BenefitCurrentView extends BenefitPeriodView {
  /** Days left including today. */
  daysLeft: number;
  /** Null when usage is unknown. */
  remainingMinor: number | null;
  /** Ends within the cadence's reminder window with something left (or unknown). */
  resetsSoon: boolean;
}

export interface BenefitView {
  id: string;
  name: string;
  kind: BenefitDefinition['kind'];
  unit: 'usd' | 'count';
  /** For count benefits: what is counted. */
  noun?: string;
  cadence: BenefitCadence;
  cadenceLabel: string;
  enrollment: boolean;
  tracking: 'statement-credit' | 'manual';
  manualReason?: BenefitManualReason;
  verify: boolean;
  note?: string;
  /** The catalog's comparison name, when it has one (BenefitDefinition.compareAs). */
  compareAs?: string;
  /** The catalog's category, when it has one (BenefitDefinition.category). */
  category?: BenefitCategory;
  /** Cardmember-year periods cannot be placed without the card's anniversary month. */
  needsAnniversary: boolean;
  /** The selected year's periods, in order. */
  periods: BenefitPeriodView[];
  /** The period containing today, whichever year it belongs to; null when there is none. */
  current: BenefitCurrentView | null;
  /** For a once-per-several-years credit: the last use Holdr knows and when it is available again. */
  window?: { lastUsed: string | null; nextEligible: string | null };
  /** The selected year: what was captured, what was available, and how many periods have no known figure. */
  year: { capturedMinor: number; availableMinor: number; unknownPeriods: number };
  /** Counted in dollar totals: usd, and not a once-per-several-years credit. */
  inTotals: boolean;
}

export interface BenefitTotals {
  capturedMinor: number;
  availableMinor: number;
  annualFeesMinor: number;
}

export interface CardBenefitsCardView {
  cardAccountId: string;
  issuer: string;
  owner: CardOwner;
  nickname: string | null;
  last4: string | null;
  /** The five digits American Express shows, when known. */
  last5: string | null;
  status: CardAccountStatus;
  product: {
    id: string;
    name: string;
    shortName: string;
    annualFeeMinor: number | null;
    feeVerify: boolean;
    sourceUrl: string;
  } | null;
  /** How the product was found: the nickname, the owner's choice, none, or a stored choice the catalog no longer has. */
  productSource: 'auto' | 'manual' | 'none' | 'missing';
  productChoice: BenefitProductChoice;
  anniversaryMonth: number | null;
  needsAnniversary: boolean;
  benefits: BenefitView[];
  /** Issuer-reported trackers no catalog benefit of this card maps. */
  issuerTrackers: BenefitIssuerFigure[];
  totals: BenefitTotals;
}

export interface BenefitReminder {
  cardAccountId: string;
  benefitId: string;
  benefitName: string;
  unit: 'usd' | 'count';
  end: string;
  daysLeft: number;
  remainingMinor: number | null;
  source: BenefitFigureSource;
}

export interface CardBenefitsReport {
  catalogVersion: string;
  year: number;
  today: string;
  cards: CardBenefitsCardView[];
  /** Active cards only, usd benefits only. */
  household: BenefitTotals & { byOwner: Record<CardOwner, BenefitTotals> };
  /** Current periods that end soon with something left, soonest first. */
  resetsSoon: BenefitReminder[];
  /** Every product, for choosing one by hand. */
  products: Array<{ id: string; issuer: BenefitIssuer; name: string; shortName: string }>;
}
