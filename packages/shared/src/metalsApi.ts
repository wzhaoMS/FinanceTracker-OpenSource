/**
 * The metals ledger's read API (design v8 §8–§10, G3): the response shapes of `/metals/*`, shared by the API, the Gold
 * page (G4) and the follow-ups that read it (G5's receipt charges, P1's funding view). Holdings are as of a date;
 * activity is over a period on its named date basis; every measure carries its completeness, and unknown is never
 * zero. Cents are integers; troy ounces are exact rationals with a display string.
 *
 * Without the metals tables every read answers `{ installed: false }`, and every write a 409 (`not-installed`); tables
 * of another shape, or a ledger under the quarantine marker (corrections r6 §1), answer a fixed 409 (`schema-conflict`).
 * Errors are value-free.
 *
 * Types only, plus the closed lists they name.
 */

import type { CardMetalsMerchantClass } from './cardSpendingExclusions.js';
import type {
  Metal,
  MetalForm,
  MetalPack,
  MetalsBullionAnswer,
  MetalsChannel,
  MetalsCoinDesign,
  MetalsContentHold,
  MetalsCoverageKind,
  MetalsEvidenceClass,
  MetalsFineBasis,
  MetalsGuardEvidence,
  MetalsHoldReason,
  MetalsInspection,
  MetalsMassBasis,
  MetalsNetwork,
  MetalsPayoutStatus,
  MetalsPremiumBasis,
  MetalsSellStatus,
  MetalsSource,
  MetalsStatedMass,
  MetalsTenderKind,
} from './metalsLedger/model.js';
import type { MetalsClassForm } from './metalsLedger/read/assignment.js';
import type { MetalsCardLinkState } from './metalsLedger/read/cardLinks.js';
import type { MetalsMeasure } from './metalsLedger/read/completeness.js';
import type { MetalsDepositLinkState } from './metalsLedger/read/depositLinks.js';

export type { MetalsClassForm } from './metalsLedger/read/assignment.js';
export type { MetalsCardLinkState } from './metalsLedger/read/cardLinks.js';
export type {
  MetalsCompletenessCode,
  MetalsCompletenessReason,
  MetalsCompletenessState,
  MetalsMeasure,
} from './metalsLedger/read/completeness.js';
export type { MetalsDepositLinkState } from './metalsLedger/read/depositLinks.js';

/** The one price source (§9): CNBC's US-dollar spot series, daily closes. */
export const METALS_API_PRICE_SOURCE = 'cnbc-spot-daily' as const;

/**
 * Why a write or a read is refused with a 409, in the body's `reason`.
 * - `schema-conflict`: every schema state but `present` and `absent`: tables of another shape, or the quarantine marker
 *   (corrections design r6 §1, while a correction is under way). Nothing is read or written until the operator is done.
 * - `correction-unsupported`: the ledger holds a correction (a voided import, a retired account, or a version a void
 *   voided, reinstated or renewed) that this build can't read yet (corrections design r6, v1), so nothing is read and
 *   nothing is written: never an active figure.
 * - `flagged-unsupported`: v0's tripwire only (a stored line carried the title guard's flag), never answered from v1,
 *   where a flagged line holds its order for the owner's answer instead. Kept for v0's clients; a later cleanup drops it.
 */
export const METALS_API_CONFLICTS = ['not-installed', 'schema-conflict', 'preview-stale', 'flagged-unsupported', 'correction-unsupported'] as const;
export type MetalsApiConflict = (typeof METALS_API_CONFLICTS)[number];

/**
 * Why sold units have no recorded purchase today, in this order (§4.3). Show both as "sold with no recorded purchase",
 * each with its reason:
 * - `no-recorded-purchase`: on its agreed day no purchase of its class, ordered by then and kept or on the way, was left
 *   for it (likely bought before a source's records begin);
 * - `purchase-cancelled-or-returned`: on its agreed day a purchase covered it, and a purchase was cancelled or returned
 *   since. Holdings as of a day before that stay as they were: a later cancellation or return never rewrites a day.
 */
export const METALS_UNMATCHED_REASONS = ['no-recorded-purchase', 'purchase-cancelled-or-returned'] as const;
export type MetalsUnmatchedReason = (typeof METALS_UNMATCHED_REASONS)[number];

/** Sold units with no recorded purchase today, per reason: in METALS_UNMATCHED_REASONS order, only reasons with units. */
export interface MetalsUnmatchedPart {
  reason: MetalsUnmatchedReason;
  units: number;
  netMinor: number;
}

export interface MetalsNotInstalled {
  installed: false;
}

export type MetalsRead<T> = T | MetalsNotInstalled;

/** Troy ounces: the exact rational ("n/d", lowest terms) and its display, three decimals, half to even ("3.215"). */
export interface MetalsTroyOz {
  exact: string;
  display: string;
}

/** The close a figure was valued at (§9): CNBC's daily close dated on or before the day valued, or none. */
export interface MetalsPriceUsed {
  source: typeof METALS_API_PRICE_SOURCE;
  /** The admissible close's New York date; null when there is none (`price-missing`). */
  closeDate: string | null;
  /** That close in US dollars per troy ounce, as stored ("2650.4"); null with `closeDate`. */
  close: string | null;
  /** Older than 5 weekdays before the day valued (`price-stale`). */
  stale: boolean;
  /** Fewer than 3 earlier closes, so the outlier check could not run. */
  thinHistory: boolean;
  /**
   * The price moved more than 20% (D-G3-1, guard 2): the first refused day, the first close admitted once the new level
   * held (null while still refused: `stale` then follows the last admitted close) and the days between them (or to the
   * day valued). Shown while the refusal runs and for 30 days after its admission; null otherwise.
   */
  levelShift: { movedOn: string; admittedOn: string | null; days: number } | null;
  /**
   * Whether this Holdr fetches closes (`HOLDR_METALS_PRICES=1`). When off, stored closes value nothing: no close is used,
   * as if none were stored (ROOT O110).
   */
  fetching: boolean;
}

/** Units (§4.4.3): delivered D, awaiting A, sold S = S_D + S_A + unmatched U, recorded holdings H = D − S_D, and A − S_A. */
export interface MetalsClassUnits {
  delivered: number;
  awaiting: number;
  sold: number;
  soldFromDelivered: number;
  soldFromAwaiting: number;
  unmatched: number;
  held: number;
  awaitingUnassigned: number;
}

/**
 * The owner's assignment policy (`HOLDR_METALS_FUNGIBLE` in holdr.conf: a comma list of metals, such as `XAU`), carried by
 * every read whose figures the assignment makes (the overview, purchases, sales and the timeline) only while the policy
 * names a metal. Unset, those reads are metals-assignment-v1's byte for byte and carry no `assignment`. A metal it names
 * is fungible:
 * - its classes ignore form: one class per fine troy oz per unit, form `any` (key `<metal>|any|<fine>`), so its bars,
 *   ingots, coins, rounds and pieces of no stated form are assigned oldest first in one queue; metal and fine content
 *   still separate classes. Say "assigned oldest first across all forms (your rule)";
 * - a unit a sale took from awaiting reads delivered as of the sale's agreed day (delivery inferred): its class counts it
 *   in `delivered` and `soldFromDelivered`, never in `awaiting` or `soldFromAwaiting`, and says how many in
 *   `reconciliation.deliveryInferred`; recorded holdings are unchanged.
 * Every other metal's figures are metals-assignment-v1's, and products are unchanged (`stated.form` is a product's own).
 */
export interface MetalsAssignmentMethod {
  rule: 'metals-assignment-v1+fungible';
  /** The metals the policy names, in METALS order. */
  fungible: Metal[];
}

/**
 * The owner's estimate for sold units with no recorded purchase (`HOLDR_METALS_ESTIMATE_UNMATCHED` in holdr.conf: a comma
 * list of metals, such as `XAU`; rule `metals-estimate-nearest-v1`), carried by the reads whose figures it changes (the
 * overview and sales) only while it names a metal. Unset, those reads are as before byte for byte, carry no
 * `costEstimate`, and nothing below appears. For a metal it names, every unit of a sale line with no recorded purchase
 * takes an estimated cost: the unit cost of the nearest purchase of the line's own class (the assignment's class, so
 * across forms under the fungible policy) that has a unit kept or on the way and a complete cost above zero, nearest by
 * order date to the sale's agreed day, before or after it (a tie goes to the earlier order date, then the order key and
 * line). A class with no such purchase leaves its units without an estimate: `unmatched-sales`, as before.
 *
 * An estimate is a label, never a fact; wherever the page shows one it says so: "estimated from your nearest purchase of
 * the same kind", never "bought", "matched" or "paid". It is never a purchase, a lot, a cycle, a holding, a funding row
 * or a card link: purchases, holdings (every class figure and source row), the timeline, products, funding, card links
 * and deposits read exactly as without it; its units stay in `unmatched` with their reasons, and no purchase lists the
 * sale for them. Only a sale's cost basis and profit or loss, and a period's profit or loss, include it, each carrying
 * `cost-estimated` (for that sale, in place of `unmatched-sales`) and each split into its recorded and estimated parts
 * (`MetalsSale.estimate`, `MetalsProfitEstimate`); per class, `MetalsHoldingClass.estimate`.
 */
export interface MetalsCostEstimateMethod {
  rule: 'metals-estimate-nearest-v1';
  /** The metals the switch names, in METALS order. */
  metals: Metal[];
}

/** A class's units with no recorded purchase (`units.unmatched`), as of the holdings' day (`MetalsCostEstimateMethod`). */
export interface MetalsClassEstimate {
  /** Those with an estimated cost, and that cost. */
  units: number;
  costMinor: number;
  /** Those with none: the class has no purchase to estimate from. */
  unestimatedUnits: number;
}

/** A sale line's units with no recorded purchase, at an estimated cost (`MetalsCostEstimateMethod`). */
export interface MetalsSaleEstimate {
  /** The line's units with no recorded purchase (`unmatched.units`), each at `unitCostMinor`. */
  units: number;
  unitCostMinor: number;
  costMinor: number;
  /** Their nets (`unmatched.netMinor`), and the nets less the estimated cost. */
  proceedsMinor: number;
  profitMinor: number;
  /**
   * The recorded parts beside it: over its cycles with a complete cost (null when none), what the sale's `costMinor` and
   * `profitMinor` would be without the estimate. Those measures are the recorded part plus the estimated one.
   */
  recorded: { costMinor: number | null; profitMinor: number | null };
  /**
   * The purchase whose unit cost it reads, the nearest of its class. Nothing is assigned: no cycle is added, and the
   * purchase's units and the sales it lists are as without the estimate (the sale may still list the same purchase in
   * `cycles` for units it was assigned). `daysFromOrderToSale` as a cycle's: negative when the purchase was ordered after
   * the sale.
   */
  from: { lotKey: string; orderKey: string; orderDate: string; account: MetalsAccountRef; daysFromOrderToSale: number };
}

/**
 * A period's profit or loss under the estimate switch (`MetalsCostEstimateMethod`): what its value sums, part by part,
 * the value being the recorded part (null when no cycle counts) plus the estimated part. The coverage's `known` is the
 * recorded part; `estimated` is the rest of what the value sums: troy ounces on the troy-oz basis; on the sale-lines
 * basis, the lines known only with their estimate (every unit matched at a complete cost or estimated).
 */
export interface MetalsProfitEstimate {
  recordedMinor: number | null;
  estimatedMinor: number;
  /** The cost of the sales the value sums: their cycles' (null when none) and their estimates'. */
  costOfSales: { recordedMinor: number | null; estimatedMinor: number };
  estimated: { lines: number; units: number; troyOz: MetalsTroyOz };
  /** The period's units with no recorded purchase and no estimate: in no part (`unmatched-sales`). */
  unestimatedUnits: number;
}

export interface MetalsHoldingClass {
  /** `<metal>|<form>|<fine troy oz per unit>`; the form is `any` for a metal the owner's fungible policy names. */
  key: string;
  form: MetalsClassForm;
  fineTroyOzPerUnit: MetalsTroyOz;
  units: MetalsClassUnits;
  /**
   * The class's recorded holdings, in troy oz, with the class's reasons: its lots' conflict and date-unknown, its sales'
   * conflict and unmatched sales, the metal's content-unknown lots and sales (confirming content can add a lot to the
   * class, or a sale that takes its earliest unit), and the ledger-wide held records and coverage gaps. Cost, value and
   * gain carry the same reasons (cost adds cost-unattributed; value and gain the price's).
   */
  troyOz: MetalsMeasure<MetalsTroyOz>;
  costMinor: MetalsMeasure<number>;
  valueMinor: MetalsMeasure<number>;
  gainMinor: MetalsMeasure<number>;
  /**
   * D − S = H, or the lines that name the difference: S_A (sold while awaiting delivery) and U (no recorded purchase).
   * `deliveryInferred`, only in a class of form `any` (`MetalsAssignmentMethod`): the units sales took from awaiting, read
   * delivered as of each sale's agreed day, so counted in D and never in `soldWhileAwaiting`.
   */
  reconciliation: { balanced: boolean; soldWhileAwaiting: number; unmatched: number; deliveryInferred?: number };
  /** Only while the owner's estimate switch names the metal (`MetalsCostEstimateMethod`): `units.unmatched`, split. */
  estimate?: MetalsClassEstimate;
}

/** A source account: its declared label ("Costco membership 1"), never a holder's name. */
export interface MetalsAccountRef {
  accountId: string;
  source: MetalsSource;
  label: string;
}

/**
 * Recorded holdings of lots this account observed first. First-in, first-out runs over one queue per class across every
 * account, so the row carries its own lots' reasons and the full reasons of every class it holds or held a lot in
 * (another account's gap, hold, quarantine or uncertain date can move a sale onto or off its lots).
 */
export interface MetalsHoldingSource extends MetalsAccountRef {
  units: number;
  troyOz: MetalsMeasure<MetalsTroyOz>;
  costMinor: MetalsMeasure<number>;
  /** At the as-of close; the rows' values split the metal's value by largest remainder, so they add up to it. */
  valueMinor: MetalsMeasure<number>;
}

/** Profit or loss coverage: in troy oz only when every sale line in the period has known content, else in sale lines. */
export type MetalsProfitCoverage =
  | { basis: 'troy-oz'; known: MetalsTroyOz; total: MetalsTroyOz; unknownContentLines: 0 }
  | { basis: 'sale-lines'; known: number; total: number; unknownContentLines: number };

/**
 * What waits for the owner. `exclusion-rule` is G5's (Spending); the metals reads never list it. `bullion-answer`: the
 * orders on this page held until the owner answers whether the lines the title guard flagged are bullion, as
 * `MetalsOverview.needsAnswer` lists them (the same orders and lines).
 */
export type MetalsNeedsYou =
  | { code: 'confirm-content'; products: number }
  | { code: 'confirmation-drift'; products: number }
  | { code: 'bullion-answer'; orders: number; flaggedLines: number }
  | { code: 'exclusion-rule' };

/**
 * Where a flagged line stands for the owner's answer, as the one matcher reads the live answers:
 * - `needs-your-answer`: no answer reaches it;
 * - `drift`: an answer for its lot or ref no longer matches it (its lot's answer pinned other evidence: any later
 *   capture of the order, a progression included, changes the evidence; or its ref has answers, none for its content
 *   fingerprint). It needs an answer again;
 * - `bullion`: answered bullion. It is a line of the metal its flag names, whose content is confirmed as any line's;
 * - `not-bullion`: answered not bullion. It is no metal, with its fee and coupon lines.
 * Its order is held while any of its flagged lines is `needs-your-answer` or `drift`.
 */
export const METALS_ANSWER_STATES = ['needs-your-answer', 'drift', 'bullion', 'not-bullion'] as const;
export type MetalsAnswerState = (typeof METALS_ANSWER_STATES)[number];

/**
 * Where a flagged line's answer is written (contract follow-up 1 §4: "keyed by productRef + content fingerprint else per
 * lot"): its product ref with its content fingerprint, whatever its pack, when it has a ref (one answer for every line of
 * that ref and fingerprint, in every order and account); else its own lot, pinned to the evidence digest it is shown
 * with (its order's active version). In a write's path both go as they are, never percent-encoded, as
 * `MetalsProductScope`'s.
 */
export type MetalsBullionScope =
  | { kind: 'product'; ref: string; fingerprint: string }
  | { kind: 'lot'; lotKey: string; evidenceDigest: string };

/** A live bullion answer: the scope it was written for (a lot answer with the digest it pinned). */
export interface MetalsBullionDecision {
  id: string;
  answer: MetalsBullionAnswer;
  scope: MetalsBullionScope;
  decidedAt: string;
}

/**
 * A line the title guard flagged (`metalUncertain`, contract follow-up 1): its title reads as no metal, but names one
 * with bullion evidence. Its WHOLE order is held for metals until every flagged line is answered.
 */
export interface MetalsAnswerLine {
  lineKey: string;
  orderKey: string;
  side: 'buy' | 'sell';
  /** Its order's source account (accountId, source, label; never a holder's name). */
  account: MetalsAccountRef;
  /** The order's date; for a sale, its agreed day. */
  date: string;
  /** The stored title, as /metals/products shows titles. */
  title: string | null;
  productRef: string | null;
  units: number;
  /** The line's own stated amount. */
  amountMinor: number;
  /** The metal its title names (null: several) and the guard's evidence, closed codes in the guard's order. */
  flag: { metal: Metal | null; evidence: MetalsGuardEvidence[] };
  state: MetalsAnswerState;
  /** Where an answer for it is written now. */
  scope: MetalsBullionScope;
  /**
   * The live answer governing it, as the matcher reads them: its lot's (answering it, or drifted when pinned to other
   * evidence), else its own scope's; null when there is none (a drift on its ref names no one answer). Revoke by its id.
   */
  decision: MetalsBullionDecision | null;
  /** Its order is held for metals now: one of its flagged lines is `needs-your-answer` or `drift`. */
  orderHeld: boolean;
}

/**
 * The orders held for metals on this metal's page, each until the owner answers its flagged lines. Until then the WHOLE
 * order, every line flagged or not, is in no figure, list or product; card charges of its merchant class in its
 * settlement window read `competitor-held`; and every figure it would reach carries `source-held`, the order counted
 * once. A held order is on a metal's page if and only if it puts that reason on the metal's figures: for each flagged
 * line's flag metal, each other line's own metal, and every metal when one of them is unknown (null).
 */
export interface MetalsNeedsAnswer {
  orders: number;
  /** Every flagged line of those orders: `items.length`. */
  flaggedLines: number;
  /** Per source, in METALS_SOURCES order, with no zero rows. */
  bySource: Array<{ source: MetalsSource; orders: number; flaggedLines: number }>;
  /** Per card merchant class the orders bar, in CARD_METALS_MERCHANT_CLASSES order, with no zero rows (a sale has none). */
  byMerchantClass: Array<{ merchantClass: CardMetalsMerchantClass; orders: number }>;
  /**
   * Every flagged line of those orders, by date, then order key, then line key, each with its state: a held order's lines
   * already answered show their answers, so the owner sees what is left to answer.
   */
  items: MetalsAnswerLine[];
}

/**
 * `GET /metals/answers?metal=`: every line the title guard flagged, of every order on the metal's page (the page rule of
 * `MetalsNeedsAnswer`, whether the order is held, counted, or left the ledger), in every state, by date, then order key,
 * then line key: what the owner reviews, answers again (drift) or revokes. `MetalsOverview.needsAnswer` lists the held
 * orders only.
 */
export interface MetalsAnswers {
  installed: true;
  metal: Metal;
  items: MetalsAnswerLine[];
}

/** What is only for the owner's information; each names how many records it concerns. */
export type MetalsForInformation =
  | { code: 'unmatched-sales'; units: number; reasons: Array<{ reason: MetalsUnmatchedReason; units: number }> }
  | { code: 'card-not-linked'; charges: number; states: Array<{ state: Exclude<MetalsCardLinkState, 'linked'>; count: number }> }
  | {
    code: 'deposit-not-linked';
    /** Payouts of sale orders that are provably this metal alone (every line this metal, no non-metal item). */
    deposits: number;
    /** For `not-covered`, the last day the bound checking account's imported coverage reaches (null: none). */
    states: Array<{ state: Exclude<MetalsDepositLinkState, 'linked'>; count: number; coveredThrough: string | null }>;
    /**
     * Unlinked payouts of sale orders that aren't one metal alone but have a line of it or of unknown metal: listed
     * apart, the same on every page they show on (an order of unknown metal only shows on every page).
     */
    mixedMetal: number;
  }
  /**
   * Held records still open: keyed ones once per key, keyless ones once per import that observed them, so the count is
   * an upper bound. Label them held records, never orders.
   */
  | { code: 'source-held'; records: number; reasons: Array<{ reason: MetalsHoldReason; count: number }> }
  | { code: 'conflict'; orders: number }
  | { code: 'date-unknown'; records: number }
  | { code: 'cost-unattributed'; orders: number }
  | { code: 'metal-unknown'; records: number }
  | { code: 'premium-disagreement'; records: number };

export interface MetalsCoverageKindEntry {
  kind: MetalsCoverageKind;
  /** The latest known import's stated window and counts for this kind (an import the read doesn't know is never shown). */
  from: string;
  to: string;
  complete: boolean;
  stated: number | null;
  seen: number;
  /** Every day any complete known import covered, merged: the dates covered. */
  ranges: Array<{ from: string; to: string }>;
}

export interface MetalsCoverageEntry extends MetalsAccountRef {
  /** When the latest capture behind the account was taken (null for a Costco retail payload, which states none). */
  capturedAt: string | null;
  importedAt: string;
  /** Only the kinds a known import states coverage for: a kind not listed was never covered. */
  kinds: MetalsCoverageKindEntry[];
  /** Held records still open: no later import has read them. */
  held: number;
}

/**
 * `GET /metals/overview?metal=&from=&to=&asOf=`: holdings as of `asOf` (today in New York by default), activity over
 * [from, to] (from the beginning when `from` is absent; `to` today by default).
 */
export interface MetalsOverview {
  installed: true;
  metal: Metal;
  /** Every metal the ledger has a purchase or a sale of, for the switch. */
  metals: Array<{ metal: Metal; lots: number; sales: number }>;
  asOf: string;
  /** The close the holdings are valued at (as of `asOf`). */
  price: MetalsPriceUsed;
  holdings: {
    troyOz: MetalsMeasure<MetalsTroyOz>;
    costMinor: MetalsMeasure<number>;
    valueMinor: MetalsMeasure<number>;
    gainMinor: MetalsMeasure<number>;
    /** Summed over the classes. */
    units: MetalsClassUnits;
    awaitingTroyOz: MetalsMeasure<MetalsTroyOz>;
    awaitingUnassignedTroyOz: MetalsMeasure<MetalsTroyOz>;
    /**
     * Purchases and sales whose content is unknown: in no class, counted once at the metal. `units` are the lots' kept
     * units (delivered and kept, or on the way) and `costMinor` their cost, each unit's share as `bought` reads it.
     */
    contentUnknown: { lots: number; units: number; costMinor: number; sales: number; saleNetMinor: number };
    classes: MetalsHoldingClass[];
    bySource: MetalsHoldingSource[];
    /** Where it's kept: not recorded until the owner says (null). */
    storage: null;
  };
  /**
   * Purchases and sales whose metal itself is unknown (a line naming several metals), as of `asOf`: in no metal's figures,
   * the same for every metal, shown beside them. `units` and `costMinor` are the kept units and their cost, as in
   * `holdings.contentUnknown`.
   */
  metalUnknown: { lots: number; units: number; costMinor: number; sales: number; saleNetMinor: number };
  activity: {
    /** Null: from the beginning. */
    from: string | null;
    to: string;
    /**
     * By order date: units kept or on the way (delivered and kept, or awaiting delivery; neither cancelled nor returned),
     * as known today. Label it "kept or on the way", never just "bought".
     */
    bought: { lots: number; units: number; troyOz: MetalsMeasure<MetalsTroyOz>; costMinor: MetalsMeasure<number> };
    /**
     * By agreed day: sale lines not cancelled. Money is stated for every line, content known or not; it carries the sell
     * side's gaps in the period (a quarantined sale, an open held record, sell orders not covered). Fees and net carry
     * `cost-unattributed` for a line whose order's fees or credits couldn't be attributed to its lines (an order of metal
     * and non-metal items): its net proceeds are approximate.
     */
    sold: {
      lines: number;
      units: number;
      troyOz: MetalsMeasure<MetalsTroyOz>;
      grossMinor: MetalsMeasure<number>;
      feesMinor: MetalsMeasure<number>;
      netMinor: MetalsMeasure<number>;
      /** Units of those lines with no recorded purchase today, and why (the parts add up to it). */
      unmatched: { units: number; netMinor: number; reasons: MetalsUnmatchedPart[] };
    };
    /**
     * Profit or loss on sales agreed in the period: the sell side's gaps in the period (every quarantined sale of the
     * metal, open held sell records, sell orders not covered) and every reason each of its sales carries
     * (`MetalsSale.profitMinor`). `estimate`, only while the owner's estimate switch names the metal
     * (`MetalsCostEstimateMethod`): the value then includes the estimated part, and this says what it sums, part by part.
     */
    profit: { valueMinor: MetalsMeasure<number>; coverage: MetalsProfitCoverage; estimate?: MetalsProfitEstimate };
    /**
     * By payout date, of sale orders that are provably this metal alone (every line this metal and no non-metal item on
     * the sale), with their gaps (every quarantined sale of the metal, an open held sell record dated on or before the
     * period's end or undated, sell orders or payouts not covered from the earlier of the period's start (in all time,
     * the first sale) and the kind's first covered day; a period ending before a kind's first covered day, or a kind
     * never covered, is never covered). A payout of a sale that isn't one metal alone (a line of another metal, a line
     * whose metal is unknown, or a non-metal item) belongs to no one metal: it is listed apart in `mixedMetal`, never in
     * a metal's totals, with the same gaps. It shows on the page of each metal the order has a line of, and an order
     * with a line of unknown metal shows on every page. Say "sales that aren't one metal alone".
     */
    payouts: { count: number; amountMinor: MetalsMeasure<number>; mixedMetal: { count: number; amountMinor: MetalsMeasure<number> } };
  };
  toCheck: { records: number; needsYou: MetalsNeedsYou[]; forInformation: MetalsForInformation[] };
  /** Orders held for metals on this page, until the owner answers whether their flagged lines are bullion. */
  needsAnswer: MetalsNeedsAnswer;
  coverage: MetalsCoverageEntry[];
  /**
   * The served coverage proof as of `asOf` (design v3.2 §6.7, §8.2): the headline's gate (b), the same for every
   * `metal`, `from` and `to`. When the card check can't be computed, every scope and total is `unavailable` and carries
   * `card-check`.
   */
  coverageProof: MetalsCoverageProof;
  /** The owner's fungible policy, only while it names a metal (`MetalsAssignmentMethod`). */
  assignment?: MetalsAssignmentMethod;
  /** The owner's estimate switch, only while it names a metal (`MetalsCostEstimateMethod`). */
  costEstimate?: MetalsCostEstimateMethod;
}

/**
 * A binding the roster preview shows (design v3.2 §6.5, §7.4): a key with at least one evidence row (one with none can't
 * be answered). The evidence is every non-explained in-scope purchase row of its groups, at any date.
 */
export interface MetalsRosterPreviewBinding {
  /** `source:<source>` (a mixed source, or the source an alias maps to) or `group:<group>` (an unsupported dealer or an unresolved processor). */
  key: string;
  rows: number;
  /** Its rows per capture status: display only, in no digest (a coverage label never stales an answer). */
  statuses: Record<Exclude<MetalsCardCheckStatus, 'explained'>, number>;
  /** The server-computed digest of its evidence (`metalsBindingDigest`). */
  digest: string;
}

/**
 * `GET /metals/sources/roster/preview` (design v3.2 §7.4): what an owner answer would bind. The rows themselves are the
 * card check's, at the same `snapshot`.
 */
export interface MetalsRosterPreview {
  installed: true;
  /** Equal to the card check's and the overview proof's when they read the same data version (§8.3). */
  snapshot: string;
  /** Every supported source, with its imported accounts (none: empty). */
  importedAccounts: Array<{ source: MetalsSource; accounts: Array<{ accountId: string; label: string; retired: boolean }> }>;
  /** By key. */
  bindings: MetalsRosterPreviewBinding[];
  /** The preview digest (`metalsRosterPreviewDigest`): every binding's key, row count and digest, and the imported accounts. */
  digest: string;
}

/** Fine content per ordered unit, with its authority, or the hold naming every step that lacked one. */
export type MetalsContent =
  | { known: true; troyOzPerUnit: MetalsTroyOz; troyOz: MetalsTroyOz; basis: MetalsFineBasis }
  | { known: false; hold: MetalsContentHold; missing: MetalsContentHold[] };

/** A Holdr account a link reaches: always its name and its ending; a card names its issuer and owner too. */
export interface MetalsLinkedAccount {
  id: string;
  /** A card's nickname, else its issuer; a checking account's label. */
  name: string;
  /** The digits the issuer or bank shows (a card's last 5 when known, else its last 4). */
  ending: string | null;
  issuer?: string;
  owner?: string;
}

export interface MetalsPurchaseCard {
  evidenceClass: MetalsEvidenceClass;
  amountMinor: number;
  state: MetalsCardLinkState;
  /** True only for a link (proof); a candidate proves nothing. */
  proof: boolean;
  /** The linked row (`card_transactions` id), or for `ineligible` the one row it would take (a candidate). */
  row: { id: string; date: string; account: MetalsLinkedAccount } | null;
}

export type MetalsDeliveryState = 'delivered' | 'in-store' | 'shipped' | 'awaiting' | 'partly-delivered' | 'cancelled'
  | 'returned';

export interface MetalsPurchase {
  key: string;
  orderKey: string;
  /** The account that observed the order first. */
  account: MetalsAccountRef;
  channel: MetalsChannel;
  orderDate: string;
  /** An event this lot counts has no date or only a year-inferred one. */
  dateUnknown: boolean;
  title: string | null;
  productRef: string | null;
  form: MetalForm | null;
  /** Walmart's marketplace seller (a guarded name or `seller-<hash8>`); null elsewhere. */
  seller: string | null;
  quantity: number;
  /** As known today. */
  units: { ordered: number; cancelled: number; returned: number; delivered: number; awaiting: number };
  delivery: { state: MetalsDeliveryState; date: string | null };
  costMinor: MetalsMeasure<number>;
  /**
   * What the lot's kept units cost before tax, shipping and fees: their share (the ledger's unit split, earlier units
   * first) of the line's merchandise, which is its amount, plus the coupons that target it, plus its attributed shares
   * of the order-level discounts (the order's `discount`, and each coupon that targets no line), split as the ledger's
   * allocation splits them. The kept units are as of today (this row's `units`), so a later cancellation or return
   * lowers the figure for every period, an earlier one's included. Never the line's own shipping, a fee, or a share of
   * the order's tax or shipping; never inferred from `costMinor`. It can be negative when the line's coupons and its
   * discount shares together exceed its amount. The basis of Costco's Executive reward (about 2% of pre-tax purchases,
   * less refunds; Costco a_id 1008254). Partial only when an order-level discount that could have reached the line
   * stayed unattributed (`cost-unattributed`), while the order is quarantined (`conflict`), as `costMinor`, and while how
   * many of the lot's units are kept is uncertain (`date-unknown`: a cancellation or return undated, year-inferred or
   * contradicting the other events as of today).
   */
  merchandiseMinor: MetalsMeasure<number>;
  content: MetalsContent;
  /** Cost per troy oz over the purchase day's close, a proxy, in cents; null when either is unknown. */
  premiumPaidPerOzMinor: number | null;
  purchaseSpot: { closeDate: string } | null;
  /** The order's payment methods (no card digits). */
  funding: Array<{ kind: MetalsTenderKind; network: MetalsNetwork; amountMinor: number | null }>;
  /**
   * Whether the order's card funding settles in one charge its evidence class admits (`admitted`), is an aggregate
   * that can never link (`aggregate`: several shipments or methods, refunded, cancelled, unknown amounts, or funding
   * that contradicts itself), or has no card.
   */
  cardEvidence: 'admitted' | 'aggregate' | 'none';
  /** One per admitted card subject of the order (a warehouse receipt can have several); empty otherwise. */
  cards: MetalsPurchaseCard[];
  /** The order's refunds as the source shows them (negative cents), shown and never linked; repeated on each lot of the order. */
  refunds: Array<{ amountMinor: number; date: string | null }>;
  sales: Array<{ saleKey: string; agreedDate: string; units: number }>;
  /** A later capture contradicts the order: figures partial (`conflict`), and it proves nothing until resolved. */
  quarantined: boolean;
}

/** `GET /metals/purchases?metal=&from=&to=`: lots of the metal ordered in [from, to]. */
export interface MetalsPurchases {
  installed: true;
  metal: Metal;
  from: string | null;
  to: string;
  purchases: MetalsPurchase[];
  /** The owner's fungible policy, only while it names a metal (`MetalsAssignmentMethod`). */
  assignment?: MetalsAssignmentMethod;
}

export interface MetalsSalePayout {
  key: string;
  amountMinor: number;
  payoutDate: string | null;
  status: MetalsPayoutStatus;
  deposit: {
    state: MetalsDepositLinkState;
    /** True only for a link; `possible` and `ineligible` matches are candidates and classify nothing. */
    proof: boolean;
    /** The linked credit, or the possible or ineligible one. */
    row: { id: string; date: string; account: MetalsLinkedAccount } | null;
    /** The last day the bound checking account's imported coverage reaches; null when unbound or none. */
    coveredThrough: string | null;
  };
}

export interface MetalsSaleCycle {
  lotKey: string;
  orderKey: string;
  units: number;
  troyOz: MetalsTroyOz;
  orderDate: string;
  account: MetalsAccountRef;
  daysFromOrderToSale: number;
  /** Null when the purchase's cost is incomplete. */
  costMinor: number | null;
  proceedsMinor: number;
  profitMinor: number | null;
  premiumPaidPerOzMinor: number | null;
  salePremiumPerOzMinor: number | null;
  fromSpotMinor: number | null;
  fromPremiumsMinor: number | null;
  purchaseSpot: { closeDate: string } | null;
  /** The purchase's order is quarantined (§4.2): a later capture contradicts it, so this cycle's cost is contested. */
  lotQuarantined: boolean;
}

export type MetalsSaleSpot =
  | { basis: 'dealer-implied' }
  | { basis: 'close-proxy'; closeDate: string };

export interface MetalsSale {
  key: string;
  orderKey: string;
  account: MetalsAccountRef;
  agreedDate: string;
  tradeMoment: string;
  status: MetalsSellStatus;
  inspection: MetalsInspection | null;
  program: string | null;
  premium: { text: string; basis: MetalsPremiumBasis } | null;
  title: string | null;
  productRef: string | null;
  form: MetalForm | null;
  quantity: number;
  grossMinor: number;
  feesMinor: number;
  netMinor: number;
  content: MetalsContent;
  matched: { units: number; netMinor: number };
  /** Units with no recorded purchase today, and why (the parts add up to it; empty when none). */
  unmatched: { units: number; netMinor: number; reasons: MetalsUnmatchedPart[] };
  /** Every unit matched to a purchase with complete cost. */
  known: boolean;
  /**
   * Its cost basis and its profit or loss, over its cycles with a complete cost (unknown when none; a cancelled sale's
   * are 0), each with every reason that could change them: its own (unknown content, unmatched units, an incomplete cost
   * of its purchases or fees and credits of its order not attributed to it, both `cost-unattributed`, a date-uncertain
   * cancellation or return), the metal's unconfirmed content first-in, first-out could reach before it (a content-unknown
   * lot ordered on or before its agreed day, or a content-unknown sale agreed on or before it), every quarantined order of
   * the metal (`conflict`, fail-closed), the held records and coverage gaps of either side up to its day, and an open held
   * record of its own key (`source-held`; a cancelled sale's too). The period's profit or loss carries all of these for
   * each of its sales, so a sale row never looks complete while its profit isn't. With an `estimate`, both add its
   * estimated part and carry `cost-estimated` in place of `unmatched-sales`.
   */
  costMinor: MetalsMeasure<number>;
  profitMinor: MetalsMeasure<number>;
  /**
   * A date-uncertain cancellation or return in its class could change the purchases it is assigned (G1d's
   * `dateUnknownLots`): its result is `date-unknown`.
   */
  dateUnknown: boolean;
  /**
   * Another contradicted order could change which purchases it took: some other order of the metal (or with a line of
   * unknown metal) is quarantined (fail-closed). Its own contradiction is `quarantined`. Its `costMinor` and `profitMinor`
   * carry `conflict` exactly when this or `quarantined` is true; their state words come from the measures.
   */
  purchaseConflict: boolean;
  /** The sale order's payouts: shared by every line of the order, so never summed across its lines. */
  payouts: MetalsSalePayout[];
  cycles: MetalsSaleCycle[];
  /**
   * The dealer's implied spot (a readable premium per troy ounce that reconciles with the price and content), or the
   * agreed day's close, a proxy.
   */
  saleSpot: MetalsSaleSpot | null;
  /**
   * A premium on the troy ounce basis can't be read or doesn't reconcile within its stated roundings: the spot is the
   * proxy. A premium per unit gives the proxy unflagged.
   */
  premiumDisagreement: boolean;
  /** A later capture contradicts this sale: its figures carry `conflict` on its own key, and it proves nothing until resolved. */
  quarantined: boolean;
  /**
   * Only while the owner's estimate switch names its metal (`MetalsCostEstimateMethod`) and it has units with no recorded
   * purchase: their estimated cost, or null when its class has no purchase to estimate from (it keeps `unmatched-sales`).
   */
  estimate?: MetalsSaleEstimate | null;
}

/** `GET /metals/sales?metal=&from=&to=`: sale lines of the metal agreed in [from, to]. */
export interface MetalsSales {
  installed: true;
  metal: Metal;
  from: string | null;
  to: string;
  sales: MetalsSale[];
  /** The owner's fungible policy, only while it names a metal (`MetalsAssignmentMethod`). */
  assignment?: MetalsAssignmentMethod;
  /** The owner's estimate switch, only while it names a metal (`MetalsCostEstimateMethod`). */
  costEstimate?: MetalsCostEstimateMethod;
}

export interface MetalsTimelineMonth {
  /** YYYY-MM. */
  month: string;
  /** The day valued: the month's last day, or today for the current month. */
  endDate: string;
  /** False when no source covered the month ("Not recorded"): a gap, never a zero. */
  recorded: boolean;
  troyOz: MetalsMeasure<MetalsTroyOz>;
  costMinor: MetalsMeasure<number>;
  valueMinor: MetalsMeasure<number>;
  closeDate: string | null;
}

/** `GET /metals/timeline?metal=&fromMonth=&toMonth=`. */
export interface MetalsTimeline {
  installed: true;
  metal: Metal;
  months: MetalsTimelineMonth[];
  /** The owner's fungible policy, only while it names a metal (`MetalsAssignmentMethod`). */
  assignment?: MetalsAssignmentMethod;
}

/**
 * `GET /metals/closes?metal=&from=&to=`: the metal's daily closes as valuation's screen admits them (D-G3-1,
 * `metals-close-screen-v2`), admissible ones only, dated in [from, to] and oldest first. Without `from` every stored day
 * is read; `to` defaults to today in New York. A refused bar is never listed: today's (incomplete), an unreadable one, a
 * date two closes disagree on, a close outside its metal's plausibility band, or an outlier.
 *
 * It reads the stored closes and never fetches, for any principal. Closes are fetched only by the Gold page's valuing
 * reads (overview, purchases, sales, timeline) of a signed-in owner, and only when this Holdr fetches prices
 * (`HOLDR_METALS_PRICES=1`). While prices are off it answers the closes already stored, if any (none on a fresh
 * install), with `fetching: false`, so a chart can say that its closes are not being updated. Valuation reads them only
 * while this Holdr fetches: while prices are off they value nothing (ROOT O110).
 */
export interface MetalsCloses {
  installed: true;
  metal: Metal;
  /** Whether this Holdr fetches closes (`HOLDR_METALS_PRICES=1`), as `MetalsPriceUsed.fetching`. */
  fetching: boolean;
  /** Each admissible close: its New York date, and US dollars per troy ounce as `MetalsPriceUsed.close` gives it ("2650.4"). */
  closes: Array<{ date: string; close: string }>;
}

/**
 * One row to confirm: product-wide (a `single` pack with a product ref, one row per content fingerprint), or one line
 * (a pack, an unclear pack, or no product ref) with the evidence digest it is shown. `lotKey` is the line's key: a
 * purchase's lot or a sale line.
 *
 * In a write's path both go as they are, never percent-encoded: `/metals/products/costco:300001/content`. Their
 * characters are path-safe (a ref is `<source>:` and letters, digits, `_` or `-`), and Holdr's ingress refuses an
 * escaped `:` (`%3A`) with a 400 (`forbidden-escape`), so `encodeURIComponent(ref)` would fail every product write.
 */
export type MetalsProductScope =
  | { kind: 'product'; ref: string; fingerprint: string }
  | { kind: 'lot'; lotKey: string; evidenceDigest: string; why: 'pack-multiple' | 'pack-unknown' | 'ref-missing' | 'ref-not-unique' };

export interface MetalsProductDecision {
  id: string;
  metal: Metal;
  troyOzPerUnit: MetalsTroyOz;
  decidedAt: string;
}

export interface MetalsProduct {
  scope: MetalsProductScope;
  source: MetalsSource;
  /** What its titles say, as stored. */
  titles: string[];
  stated: {
    metal: Metal | null;
    form: MetalForm | null;
    mass: MetalsStatedMass | null;
    purity: string | null;
    massBasis: MetalsMassBasis | null;
    design: MetalsCoinDesign | null;
  };
  pack: MetalPack;
  /** A pack's count; always null in v1 (no reviewed count rule). */
  packCount: number | null;
  /** What the title suggests per ordered unit; it counts for nothing until confirmed. */
  proposal: { metal: Metal; troyOzPerUnit: MetalsTroyOz } | null;
  /** Purchase lines and sale lines in the scope, and their units. */
  lots: number;
  saleLines: number;
  units: number;
  /** The hold its lines are under; null when their content is known. */
  hold: MetalsContentHold | null;
  /** The live decision answering the scope, if any. */
  decision: MetalsProductDecision | null;
  /** A decision exists for this ref or line, but these details differ from what it confirmed: held until confirmed. */
  drift: boolean;
  /** How the content is known when it is (`owner-confirmed`, `coin-specification`, `stated-mass-basis`). */
  basis: MetalsFineBasis | null;
}

/** `GET /metals/products?metal=`. */
export interface MetalsProducts {
  installed: true;
  metal: Metal;
  products: MetalsProduct[];
}

/** What a confirmation or a revocation would change, bound by its digest; a stale one is refused (409 `preview-stale`). */
export interface MetalsContentPreview {
  digest: string;
  /** Lines whose content the write changes, and their units. */
  lots: number;
  units: number;
  /** Recorded holdings of the metal today, in troy oz, before and after. */
  holdingsTroyOz: { before: MetalsMeasure<MetalsTroyOz>; after: MetalsMeasure<MetalsTroyOz> };
  /** Sale lines whose profit or loss becomes known (or unknown again, on a revocation). */
  saleLines: number;
}

/**
 * `POST /metals/products/:ref/content` `{ fingerprint, metal, troyOzPerUnit, preview }` and
 * `POST /metals/lots/:key/content` `{ evidenceDigest, metal, troyOzPerUnit, preview }`: with `preview: null` nothing is
 * written and the answer is the preview; with its digest the decision is written (201), unless anything changed since
 * (409 `preview-stale`). `troyOzPerUnit` is fine troy ounces per ordered unit, positive, at most 10000: an exact "n/d"
 * (each side at most 12 digits) or a decimal with at most 7 decimals ("1", "0.1").
 */
export type MetalsContentWrite =
  | { written: false; preview: MetalsContentPreview }
  | { written: true; decision: MetalsProductDecision };

/**
 * `DELETE /metals/products/:ref/content?decision=<id>[&preview=<digest>]` (and `…/lots/:key/content`): without a
 * preview nothing is revoked and the answer is the preview; with its digest the decision is revoked (its lines are held
 * again), unless anything changed since (409 `preview-stale`).
 */
export type MetalsContentRevoke =
  | { revoked: false; preview: MetalsContentPreview }
  | { revoked: true; decision: { id: string; revokedAt: string } };

/** A metal's figures a bullion answer can change, as the preview shows them (none depends on a price). */
export interface MetalsBullionFigures {
  /** Purchase lines and sale lines of the metal in the figures. */
  lots: number;
  saleLines: number;
  /** Recorded holdings today, in troy oz and at cost. */
  holdingsTroyOz: MetalsMeasure<MetalsTroyOz>;
  holdingsCostMinor: MetalsMeasure<number>;
  /** In all time: kept or on the way, at cost; and sold, net. */
  boughtCostMinor: MetalsMeasure<number>;
  soldNetMinor: MetalsMeasure<number>;
}

/** The orders a bullion answer reaches, by how the read counts them: held for metals, counted, or left the ledger. */
export interface MetalsBullionOrderCounts {
  held: number;
  counted: number;
  left: number;
}

/**
 * What a bullion answer or its revocation would change, bound by its digest; a stale one is refused (409
 * `preview-stale`). The digest binds the change, the answer it replaces, the evidence of every flagged line it reaches
 * (each with its order's active version digest and quarantine, and how it reads before and after), today's date in New
 * York (a preview made before midnight there is stale after it) and every figure below.
 */
export interface MetalsBullionPreview {
  digest: string;
  /** Flagged lines whose state the change moves, and their units. */
  lines: number;
  units: number;
  /** The orders of the flagged lines it reaches, before and after. */
  orders: { before: MetalsBullionOrderCounts; after: MetalsBullionOrderCounts };
  /** Each metal whose figures change, in METALS order. */
  metals: Array<{ metal: Metal; before: MetalsBullionFigures; after: MetalsBullionFigures }>;
  /** Purchase and sale lines whose metal is unknown (a flag naming several metals), before and after. */
  metalUnknown: { before: { lots: number; saleLines: number }; after: { lots: number; saleLines: number } };
  /** Card charges (each tender of a buy) whose link changes; sale payouts whose deposit link changes. */
  cardLinks: number;
  deposits: number;
}

/**
 * `POST /metals/products/:ref/bullion` `{ fingerprint, answer, preview }` and `POST /metals/lots/:key/bullion`
 * `{ evidenceDigest, answer, preview }` (a flagged line with no product ref only): with `preview: null` nothing is
 * written and the answer is the preview; with its digest the answer is written (201), unless anything changed since (409
 * `preview-stale`). It replaces the live answer of exactly its own scope; an answer for another fingerprint of the same
 * ref stays.
 */
export type MetalsBullionWrite =
  | { written: false; preview: MetalsBullionPreview }
  | { written: true; decision: MetalsBullionDecision };

/**
 * `DELETE /metals/products/:ref/bullion?decision=<id>[&preview=<digest>]` (and `…/lots/:key/bullion`): without a preview
 * nothing is revoked and the answer is the preview; with its digest the answer is revoked (its lines need an answer
 * again), unless anything changed since (409 `preview-stale`).
 */
export type MetalsBullionRevoke =
  | { revoked: false; preview: MetalsBullionPreview }
  | { revoked: true; decision: { id: string; revokedAt: string } };

/** A buy order's funding by kind (§10): card evidence with its class and link state, stored value, other, not stated. */
export interface MetalsFundingPurchase {
  orderKey: string;
  account: MetalsAccountRef;
  orderDate: string;
  fullPriceMinor: number;
  /** The metals its lines name, each once, sorted. A line of unknown metal names none: `metalUnknownLines` counts it. */
  metals: Metal[];
  /** Its lines of unknown metal (a title naming more than one metal): in no metal's figures, so never in `metals`. 0 when none. */
  metalUnknownLines: number;
  /** Every money line of the order is metal. */
  allMetal: boolean;
  quarantined: boolean;
  cardEvidence: 'admitted' | 'aggregate' | 'none';
  cards: MetalsPurchaseCard[];
  /**
   * Its receipt-confirmed charges (§10, G1d `metalsReceiptCharges`): proof-linked rows of an order whose principal lines
   * are all metal, named by its metals (`metal-unknown` for a line naming several). Evidence for the owner, never a decision.
   */
  receiptCharges: Array<{ rowId: string; evidenceClass: MetalsEvidenceClass; metals: Array<Metal | 'metal-unknown'> }>;
  refunds: Array<{ amountMinor: number; date: string | null }>;
  byKind: Array<{
    kind: 'card' | 'shop-card' | 'gift-card' | 'store-balance' | 'other' | 'not-stated';
    methods: number;
    /** Null when any method of the kind states no amount. */
    amountMinor: number | null;
  }>;
}

export interface MetalsFundingSale {
  orderKey: string;
  account: MetalsAccountRef;
  agreedDate: string;
  netMinor: number;
  /** As a purchase's: the metals its lines name, and its lines of unknown metal counted apart. */
  metals: Metal[];
  metalUnknownLines: number;
  quarantined: boolean;
  payouts: MetalsSalePayout[];
}

/** A checking credit a payout reaches: proof classifies it as asset-sale proceeds (never income); a candidate, nothing. */
export interface MetalsFundingDeposit {
  rowId: string;
  saleKey: string;
  payoutKey: string;
  state: MetalsDepositLinkState;
  proof: boolean;
  classification: 'asset-sale-proceeds' | null;
}

/** `GET /metals/funding?from=&to=` (P1): buy orders by order date and sales by agreed day in [from, to]. */
export interface MetalsFunding {
  installed: true;
  from: string | null;
  to: string;
  purchases: MetalsFundingPurchase[];
  sales: MetalsFundingSale[];
  deposits: MetalsFundingDeposit[];
}

// ---------------------------------------------------------------------------
// The served coverage proof (card cross-check design v3.2 §6.7; G1d C6, C7)
// ---------------------------------------------------------------------------

export const METALS_COVERAGE_PROOF_RULE = 'metals-coverage-proof-v1' as const;

/** What raised a gap: the roster's own answer, card rows (a count) or admitted ledger records (a count). */
export type MetalsGapTrigger =
  | { by: 'roster'; decidedAt: string }
  | { by: 'card-rows'; rows: number }
  | { by: 'admitted-records'; records: number };

/** For a gap card rows raised: 'stale' when the exemption that had removed it no longer matches its evidence. */
export type MetalsGapExemption = 'none' | 'stale';

export type MetalsRosterProblem =
  | 'accounts-changed' | 'sources-changed' | 'evidence-changed'
  | 'start-after-admitted-record' | 'start-after-gold-row'
  | 'unused-source-has-buys' | 'unused-source-has-sales'
  | 'all-imported-but-none' | 'exemption-disagrees' | 'sources-incomplete' | 'answer-shape';

export type MetalsCoverageGap =
  /** id: `<accountId>|<kind>`, the measures' `not-covered` key, from the same function (C5). */
  | { id: string; variant: 'imported-window'; account: MetalsAccountRef; kind: MetalsCoverageKind;
      need: { from: string | null; to: string };
      /** Clipped to the need. `from` null: a whole-history entry covers every day before its `to` while the need's
       *  start is unknown. */
      covered: Array<{ from: string | null; to: string }>;
      missing: Array<{ from: string | null; to: string }> }
  | { id: string; variant: 'missing-account'; source: MetalsSource; imported: number; missing: number | null;
      triggers: MetalsGapTrigger[]; exemption: MetalsGapExemption }
  | { id: string; variant: 'missing-kind'; source: MetalsSource; side: 'buy' | 'sell'; accounts: MetalsAccountRef[];
      triggers: MetalsGapTrigger[]; exemption: MetalsGapExemption }
  | { id: string; variant: 'unsupported-dealer'; group: string; label: string; rows: number; exemption: MetalsGapExemption }
  | { id: string; variant: 'alias-unresolved'; group: string; rows: number; exemption: MetalsGapExemption }
  | { id: string; variant: 'unexplained-charges'; group: string; source: MetalsSource; rows: number;
      exemption: MetalsGapExemption }
  | { id: string; variant: 'missing-source'; places: number; decidedAt: string }
  | { id: string; variant: 'other-acquisition'; decidedAt: string }
  | { id: string; variant: 'roster'; state: 'not-installed' | 'unanswered' | 'stale' | 'contradicted';
      problems: MetalsRosterProblem[];
      /** The gold-only rows behind `start-after-gold-row`, each citing this gap (C6); 0 otherwise. */
      rows: number }
  | { id: string; variant: 'unproven-prefix' }
  | { id: string; variant: 'card-check-unavailable' };

export interface MetalsCoverageNeed {
  /** null: no kind of that side is needed. `from` null: acquisitionStart is unknown. */
  buy: { from: string | null; to: string } | null;
  sell: { from: string | null; to: string } | null;
}

export interface MetalsCoverageScope {
  state: 'complete' | 'incomplete' | 'unavailable';
  need: MetalsCoverageNeed | null;
  /** Every gap of this scope, by canonical id; empty only when complete. */
  gaps: MetalsCoverageGap[];
}

export interface MetalsSalesScope {
  metal: Metal;
  state: 'complete' | 'incomplete' | 'no-sales' | 'unavailable';
  /** null with no-sales or unavailable. */
  need: MetalsCoverageNeed | null;
  gaps: MetalsCoverageGap[];
}

/** `card-history` (C7) is listed only when the card check's `cardHistory` is non-empty; the others always. */
export type MetalsCoverageLimit = 'card-check-only' | 'non-card-funding' | 'stored-value-only' | 'warehouse-and-store'
  | 'cards-not-in-holdr' | 'undiscovered-dealers' | 'card-history';

export interface MetalsRosterBindingState {
  key: string;
  claim: 'no-metal-purchases' | 'accounts-complete';
  rows: number;
  state: 'current' | 'stale';
}

export interface MetalsRosterState {
  /** not-installed: the attestation table doesn't exist yet (§7.3). contradicted outranks stale. */
  state: 'not-installed' | 'unanswered' | 'current' | 'stale' | 'contradicted';
  /** The server accepts an answer now: the table is installed and the owner-answer gate is open (§7.1). */
  asking: boolean;
  decidedAt: string | null;
  acquisitionStart: string | null;
  problems: MetalsRosterProblem[];
  bindings: MetalsRosterBindingState[];
}

export interface MetalsCoverageProof {
  rule: typeof METALS_COVERAGE_PROOF_RULE;
  /** The data version every scope, gap and card-check reference was computed from (§8.3). */
  snapshot: string;
  asOf: string;
  roster: MetalsRosterState;
  /** Household-wide: every metal's purchase and sale history over [acquisitionStart, asOf]. */
  asOfScope: MetalsCoverageScope;
  /** One per metal with a recorded purchase or sale. */
  sales: MetalsSalesScope[];
  totals: {
    realized: { metals: Metal[]; state: 'complete' | 'incomplete' | 'no-sales' | 'unavailable' };
    estimate: { metals: Metal[]; state: 'complete' | 'incomplete' | 'unavailable' };
    metalUnknown: { lots: number; saleLines: number };
  };
  /** Always listed: what no card check can certify (§1). */
  limits: MetalsCoverageLimit[];
}

/** The owner's source-roster answer, `metals-source-roster-v1` (§7.2), as stored with its server-computed bindings. */
export interface MetalsSourceRosterAnswer {
  /**
   * The earliest day the household could have acquired precious metals in any way: the owner's statement, never an
   * imported record's date. Asked as a month, stored as its first day (not after today).
   */
  acquisitionStart: string;
  /** Every supported source, once. `accounts` only for a source bought or sold at; null otherwise. notImported: 1 to 99. */
  sources: Array<{ source: MetalsSource; bought: boolean; sold: boolean;
    accounts: 'all-imported' | { notImported: number } | null }>;
  /** How many other places, an integer from 0 to 99; 0 means "nowhere else". No names are stored. */
  elsewhere: { places: number };
  /** Gifts, inheritance, in-person or cash acquisitions. */
  otherWays: boolean;
  /** At most one per binding the preview showed; a binding left out keeps its gaps. */
  exemptions: Array<{ key: string; claim: 'no-metal-purchases' | 'accounts-complete' }>;
}

// ---------------------------------------------------------------------------
// `GET /metals/card-check?asOf=` (card cross-check design v3.2 §8.1; G1d C6, C7)
// ---------------------------------------------------------------------------

export const METALS_CARD_CAPTURE_RULE = 'metals-card-capture-v1' as const;
export type MetalsCardCheckStatus = 'explained' | 'possible-aggregate' | 'held' | 'outside-coverage' | 'no-capture-match';
export type MetalsCardCheckReason = 'aggregate' | 'held-record' | 'source-quarantined' | 'binding-drift'
  | 'identity-ambiguous' | 'contested' | 'ambiguous' | 'alias-unresolved' | 'outside-coverage' | 'no-capture-match';

/** One entry of the card check's own gap catalog (C2-M1). */
export interface MetalsCardCheckGap {
  /** Canonical. A financial entry's id is the proof's gap id; a diagnostic id is `diag|before-acquisition-start` or
   *  `diag|exempted` and never appears in the proof. */
  id: string;
  kind: 'financial' | 'diagnostic';
  /** Financial: every proof scope carrying this id at the same snapshot ('asOf', 'sales:<metal>'). Diagnostic: []. */
  scopes: string[];
  /** Diagnostic: why it blocks nothing. Financial: null. */
  reason: 'before-acquisition-start' | 'exempted' | null;
}

/** C7: a held card account whose card coverage doesn't span the need: a limit, never a gap (O117 R1, R2). */
export interface MetalsCardHistoryLimit {
  account: MetalsLinkedAccount;
  /** The need's days its card coverage doesn't span: ascending, disjoint, at least one. Always dated: while
   *  acquisitionStart is unknown the need starts at the earliest admitted record, or at asOf when there's none (§8.1). */
  unsynced: Array<{ from: string; to: string }>;
}

export interface MetalsCardCheckRow {
  rowId: string;
  date: string;
  amountMinor: number;
  account: MetalsLinkedAccount;
  status: Exclude<MetalsCardCheckStatus, 'explained'>;
  /** Primary first; the secondary reasons are kept. */
  reasons: MetalsCardCheckReason[];
  /** Ids in this response's `gaps`; every one resolves there. */
  gapIds: string[];
}

export interface MetalsCardCheckCredit {
  rowId: string; date: string; amountMinor: number; account: MetalsLinkedAccount;
  status: 'listed'; reason: 'no-refund-evidence-contract';
}

export interface MetalsCardCheckGroup {
  /** 'costco' | 'walmart' | 'dealer:<NAME>' | 'merchant:<root>' | 'alias:<id>' | 'unresolved:<id>' */
  group: string;
  label: string;
  scope: 'gold-only' | 'mixed-online';
  /** The source that should explain it; null for an unsupported dealer or an unresolved alias. */
  source: MetalsSource | null;
  /** The roster exemption covering this group's evidence, and whether it still matches. */
  exemption: { key: string; claim: 'no-metal-purchases' | 'accounts-complete'; state: 'current' | 'stale' } | null;
  purchases: Record<MetalsCardCheckStatus, number>;
  credits: number;
  /** Every purchase row except the explained ones, which are counted only. */
  rows: MetalsCardCheckRow[];
  creditRows: MetalsCardCheckCredit[];
}

export interface MetalsCardCheck {
  installed: true;
  rule: typeof METALS_CARD_CAPTURE_RULE;
  aliasPolicy: string;
  /** Equal to the overview's coverageProof.snapshot when both read the same data version (§8.3). */
  snapshot: string;
  asOf: string;
  gaps: MetalsCardCheckGap[];
  groups: MetalsCardCheckGroup[];
  /** Counts only. */
  outOfScope: { warehouse: number; samsClub: number; store: number; unclassed: number };
  /** Occurrences whose card couldn't be checked (§2.4), per source: limits, not gaps. */
  unchecked: Array<{ source: MetalsSource; cardNotInHoldr: number; identityAmbiguous: number }>;
  /** C7: only accounts with unsynced days; empty when every held card account's coverage spans the need. */
  cardHistory: MetalsCardHistoryLimit[];
  limits: MetalsCoverageLimit[];
}
