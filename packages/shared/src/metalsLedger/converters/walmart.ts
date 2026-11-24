/**
 * Walmart captures (`holdr-retail-capture/walmart@1`) to `holdr.metals-import` v1 payloads: the `walmart@1` converter
 * (design v8 §5.3) behind `holdr-metals-convert --source walmart`. Pure: the CLI reads the files and checks each one
 * against the owner's private manifest; this sees their bytes only, and touches no file system, network or clock.
 *
 * A Walmart account's capture is the pull's consolidated `walmart.json` and each order's raw `raw/detail-<order>.json`.
 * Each order is read on its own (a malformed order is held, never the folder) and must agree with its raw detail
 * field by field (walmartRawComparable). Then:
 * - Money: grand total = subtotal + tax + Σ fees + Σ refunds (refunds negative); grand total with tips = grand total
 *   (a driver tip is never accepted, so none is added); the lines' prices sum to the subtotal. A field the capture has
 *   never shown filled (discounts, donations, a driver tip, a charge history) holds the order when present; a missing
 *   money field holds it; nothing unknown becomes zero.
 * - Metal: Holdr's title rule on each item's RAW name, then the pack rule and the purity, mass-basis and design
 *   readings on that same raw name, before the name is sanitized for storage. A name the rule refuses is read by metal
 *   guard v1 (retailMetalTitleGuard) on that same raw name, every item assessed, as the rule reads every item's name: a
 *   name with a whole metal word and bullion evidence is flagged (`metalUncertain`), never silently no metal. A flagged
 *   line is a lot like a metal line (`metal` null, held `bullion-unconfirmed` by the content rule, and metal in the
 *   skeleton, provisionally bullion), and its order is kept in full with no card evidence: never a competitor, never
 *   skipped. Holds come first: a held order stays held, flagged or not. A name with a metal word and no bullion evidence
 *   stays no metal (drift).
 * - Funding: the order's payment methods are its tenders, each with its one stated total (`charged[]`) or null; the
 *   admission facts are read conservatively (any refund, any cancelled group). Card evidence comes only through
 *   `metalsAdmission`: an order with one card method whose total is the grand total and one group is admitted under
 *   `walmart-order-total@1`, unless a line of it is flagged. An order with no lot line (metal or flagged) but card
 *   funding is a competitor. No refund is a subject.
 * - Lifecycle (orders with a lot line): DELIVERED and PICKED_UP groups deliver their lines, CANCELED groups cancel them,
 *   each with its date and basis. A refund (Walmart never says which line it was for, or where it went), a stated return
 *   (never stated per line), a partly cancelled order whose groups all say delivered, a cancelled order with a
 *   delivered group, or a group with no status holds the order.
 * A held order keeps its key and date. Names, addresses, tracking, native numbers and gift-card endings are dropped;
 * a marketplace seller's business name is kept only behind the closed guard (ROOT's Q6 ruling), else its key.
 *
 * Coverage counts the order list's rows read to the pager's end, proved from the list pages themselves; a total the
 * site states is only ever a cross-check on that proof.
 *
 * The report's census reads the raw files again once the payload is built, apart from the routing: every captured line
 * whose raw name has a whole metal word, by its expected place and its place in the payload; the omissions must be 0.
 */

import { cardImportTextProblem, sanitizeCardText } from '../../cardImport.js';
import { containsCardData } from '../../cardNumbers.js';
import { retailMetalPack } from '../../retailImportTool/metalPackRule.js';
import {
  COIN_DESIGN_WORDS, METAL_TITLE_WORDS, NEAR_MISS_WORDS, RETAIL_METAL_GUARD, RETAIL_METAL_GUARD_CLAUSES, RETAIL_METAL_GUARD_EVIDENCE,
  retailMetalTitleEvidence, retailMetalTitleGuard, type RetailMetalEvidence, type RetailMetalGuardClause,
  type RetailMetalGuardEvidence, type RetailMetalGuardReading,
} from '../../retailImportTool/metalTitleRule.js';
import { metalsAdmission, metalsSettlementInterval } from '../admission.js';
import { METALS_UNATTRIBUTED_REASONS, metalsAllocation, type MetalsUnattributedReason } from '../allocation.js';
import { displayedCents, isCaptureDate, type CaptureIssue } from '../captures/captureRead.js';
import {
  readWalmartCapture,
  readWalmartRawDetail,
  WALMART_CAPTURE_SCHEMA,
  walmartRawComparable,
  type WalmartGroup,
  type WalmartItem,
  type WalmartOrder,
  type WalmartPayment,
  type WalmartProvenance,
} from '../captures/walmartCapture.js';
import { metalsContentFingerprint, metalsFineContent, metalsFineContentWire, type MetalsContentEvidence } from '../contentRule.js';
import {
  METAL_FORMS,
  METAL_PACKS,
  METALS,
  METALS_CAPTURE_SCHEMAS,
  METALS_CONTENT_HOLDS,
  METALS_CONVERT_POLICY_VERSION,
  METALS_FINE_BASES,
  METALS_HOLD_REASONS,
  METALS_IMPORT_FORMAT,
  METALS_IMPORT_VERSION,
  METALS_MASS_BASES,
  METALS_RULES,
  METALS_TENDER_KINDS,
  type Metal,
  type MetalForm,
  type MetalPack,
  type MetalsAdmissionFacts,
  type MetalsContentHold,
  type MetalsDateBasis,
  type MetalsEvent,
  type MetalsFineBasis,
  type MetalsHoldReason,
  type MetalsLineMetalUncertain,
  type MetalsMassBasis,
  type MetalsNetwork,
  type MetalsRules,
  type MetalsSkeletonLine,
  type MetalsTender,
  type MetalsTenderKind,
} from '../model.js';
import { metalsTitleObservations } from '../observations.js';
import {
  METALS_MAX_LINES,
  METALS_MAX_METHODS,
  METALS_MAX_ORDERS,
  METALS_PRODUCT_REF_MAX,
  METALS_TITLE_MAX,
  metalsDigest,
  metalsNaturalKey,
  metalsSellerKey,
  metalsSellerNameProblem,
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
  metalsOwnerQuestionCounts,
  type MetalsBullionCounts,
  type MetalsCaptureConverter,
  type MetalsCaptureFile,
  type MetalsCaptureFolder,
  type MetalsConfirmationCounts,
  type MetalsConvertOutput,
} from './common.js';

/** The account folders a Walmart capture lives in: `walmart`, `walmart-2`, … */
export const WALMART_ACCOUNT_FOLDER = /^walmart(?:-[1-9][0-9]{0,2})?$/;
const CONSOLIDATED_FILE = 'walmart.json';
const RAW_DETAIL_FILE = /^raw\/detail-([0-9]{1,40})\.json$/;

/** Why a whole folder is refused: nothing of it is converted. */
export const WALMART_CONVERT_REFUSALS = [
  'folder-mismatch',
  'capture-unreadable',
  'schema-unsupported',
  'currency-unsupported',
  'coverage-incomplete',
  'too-many-records',
  'title-rule-mismatch',
  'converter-invalid',
] as const;

/** Every check that can hold an order, with the reason it holds it under. A check names the rule, never a value. */
export const WALMART_HOLD_CHECKS = {
  'order-key': 'unreadable',
  'record-shape': 'unreadable',
  'raw-shape': 'unreadable',
  'line-id': 'unreadable',
  'raw-missing': 'raw-missing',
  'raw-repeats': 'capture-disagreement',
  'raw-id': 'capture-disagreement',
  'raw-disagrees': 'capture-disagreement',
  'raw-unlisted': 'capture-disagreement',
  duplicate: 'duplicate-in-capture',
  currency: 'currency-unsupported',
  'order-date': 'field-missing',
  items: 'field-missing',
  'item-name': 'field-missing',
  subtotal: 'field-missing',
  tax: 'field-missing',
  'grand-total': 'field-missing',
  'line-price': 'field-missing',
  discounts: 'field-unsupported',
  donations: 'field-unsupported',
  'driver-tip': 'field-unsupported',
  'charge-history': 'field-unsupported',
  'tax-negative': 'field-unsupported',
  'gross-negative': 'field-unsupported',
  'line-price-negative': 'field-unsupported',
  'in-store': 'field-unsupported',
  'too-many-lines': 'field-unsupported',
  'too-many-methods': 'field-unsupported',
  'tender-negative': 'field-unsupported',
  'subtotal-identity': 'identity-failed',
  'grand-total-identity': 'identity-failed',
  'tips-identity': 'identity-failed',
  'group-status': 'status-unknown',
  'refund-without-return': 'status-ambiguous',
  'partial-cancel-delivered': 'status-ambiguous',
  'cancel-delivered': 'status-ambiguous',
  'return-lines-unstated': 'return-unlinked',
  'line-quantity': 'quantity-unknown',
} as const satisfies Record<string, MetalsHoldReason>;
export type WalmartHoldCheck = keyof typeof WALMART_HOLD_CHECKS;
export const WALMART_HOLD_CHECK_NAMES = Object.keys(WALMART_HOLD_CHECKS) as WalmartHoldCheck[];

type Counts<K extends string> = Record<K, number>;
const zeroes = <K extends string>(keys: readonly K[]): Counts<K> => Object.fromEntries(keys.map((key) => [key, 0])) as Counts<K>;

/** Item lines whose raw name the title rule reads as metal, by their group's status: counts only. */
export interface WalmartMetalLineCounts {
  /** Orders with at least one. */
  orders: number;
  /** Lines in groups delivered or picked up. */
  delivered: number;
  /** Lines in cancelled groups. */
  cancelled: number;
  /** Lines in groups with any other status, or none. */
  other: number;
  /** Orders whose item names could be read in none of their files. */
  titleUnread: number;
}

/**
 * Orders held for the subtotal identity (Σ line prices outside cancelled groups = subtotal), by the shape of the
 * difference between that sum and the subtotal.
 */
export interface WalmartSubtotalShapes {
  held: number;
  linesAbove: number;
  linesBelow: number;
  withCancelledGroup: number;
  withQuantityAboveOne: number;
  withZeroPricedLine: number;
  /** Σ every line's price, cancelled groups' included, is the subtotal: the subtotal includes a cancelled group's lines. */
  allLinesExplain: number;
  /** Σ quantity × line price outside cancelled groups is the subtotal: the line prices are per unit. */
  unitPricesExplain: number;
  /** Neither of those two does. */
  neitherExplains: number;
  /** The difference is one line's price. */
  oneLineExplains: number;
  /** The difference is one stated fee. */
  oneFeeExplains: number;
  /** The difference is one other price field of the raw detail's priceDetails (a savings, say). */
  oneOtherFieldExplains: number;
}

/** Why orders were held or skipped, without showing any of them: counts, closed codes and value-free patterns only. */
export interface WalmartDiagnostics {
  /** Each order a reader refused, by its first issue: the structural path, every index as [*], and the fixed message. */
  readerIssues: Record<string, number>;
  /** The same orders, by where that first issue is: in an item, in a group, or elsewhere in the order. */
  readerIssueLevels: { item: number; group: number; order: number };
  /** Orders skipped for having no card funding: those with a name that reads as metal, and all by their tender kinds. */
  skipped: { withMetalNames: number; byTenderKinds: Record<string, number> };
  /**
   * Metal-reading item lines over every order read, and per outcome (`converted`, `competitor`, `skipped`, or
   * `held:<check>`). A held order's names are read title-only from its consolidated record, else its raw detail.
   */
  metalLines: { all: WalmartMetalLineCounts; byOutcome: Record<string, WalmartMetalLineCounts> };
  /**
   * Item lines whose name has a metal word that the title rule doesn't read as metal, read title-only as metalLines:
   * orders with one, the lines by group status over every order and per outcome, and by the clause of the rule that
   * refuses each (walmartTitleRefusal, closed codes).
   */
  titleRefusals: {
    orders: number;
    all: WalmartStatusCounts;
    byOutcome: Record<string, WalmartStatusCounts>;
    byClause: Record<string, WalmartStatusCounts>;
  };
  /**
   * What a fail-closed title guard would hold, as #297 sized one before metal guard v1 (heuristic tokens; the guard
   * itself is the census): the titleRefusals lines with bullion evidence too (a weight, fineness or karat;
   * walmartBullionTokens), with the orders they are in; per outcome; and by the order's own `isPreciousMetal` capture
   * flags (`metal`: some item flagged; `none`: none flagged, so the guard would newly hold an order the capture doesn't
   * call metal; `unread`: read from a raw detail, which has no flags). Flags are counted only, never used to convert.
   */
  titleGuard: WalmartGuardCounts & {
    byOutcome: Record<string, WalmartGuardCounts>;
    byOrderFlag: Record<'metal' | 'none' | 'unread', WalmartGuardCounts>;
  };
  /**
   * Lines with no metal word but a fineness, karat or troy-weight token (walmartBullionTokens): what a guard triggered by
   * a metal word would miss. With the orders they are in, and by each line's own item capture flag.
   */
  tokensWithoutMetalWord: WalmartGuardCounts & { byItemFlag: Record<'metal' | 'none' | 'unread', WalmartGuardCounts> };
  /** Orders held for the subtotal identity, those naming metal and the others apart. */
  subtotal: { metal: WalmartSubtotalShapes; other: WalmartSubtotalShapes };
  /**
   * For ROOT's two candidate rules, held orders by check (`held:<check>` keys are the checks): how many name no metal
   * (title-only, from any file), and of those how many have a sound grand total and a card method (could compete as an
   * aggregate capped at their full price); and how many have their own date and full price before refunds (what an
   * interval- or amount-bounded barrier would need).
   */
  held: Record<string, WalmartHeldFacts>;
}

/** Item lines by their group's status: delivered or picked up, cancelled, or any other status or none. */
export interface WalmartStatusCounts {
  delivered: number;
  cancelled: number;
  other: number;
}

/** Lines a title guard would hold, by group status, and the orders they are in. */
export interface WalmartGuardCounts {
  orders: number;
  lines: WalmartStatusCounts;
}

/** One hold check's orders, by the facts the two candidate rules would need: counts only. */
export interface WalmartHeldFacts {
  orders: number;
  /** The consolidated record has a card method (any order, metal or not). */
  withCard: number;
  /** Every readable item name reads as non-metal, and at least one reads. */
  allNonMetalTitles: number;
  /** ... and the consolidated record's grand total is subtotal + tax + Σ fees + Σ refunds. */
  nonMetalSoundGrandTotal: number;
  /** ... and it has a card method. */
  nonMetalSoundWithCard: number;
  /** The order keeps a date (its records agree on one). */
  dated: number;
  /** Its full price before refunds (subtotal + tax + Σ fees) reads from the consolidated record. */
  fullPriceKnown: number;
}

/** Why a lot line's product ref is withheld, in the validator's order of checks (productRefOf). */
export const WALMART_PRODUCT_REF_WITHHELD = ['absent', 'form', 'too-long', 'digit-run', 'card-data'] as const;
export type WalmartProductRefWithheld = (typeof WALMART_PRODUCT_REF_WITHHELD)[number];

/** Lot lines of one kind by their product ref: stored, or withheld and why. */
export interface WalmartProductRefCounts {
  stored: number;
  withheld: Counts<WalmartProductRefWithheld>;
}

/** A line of the census by where its raw reading puts it: `drift` belongs elsewhere (not a lot, not held). */
export type WalmartCensusExpected = 'held' | 'metal' | 'flagged' | 'drift';
/** A line of the census by where the payload puts it. */
export type WalmartCensusActual = 'held' | 'metal' | 'flagged' | 'elsewhere';

/**
 * Metal guard v1's census (guard-integration spec, Amendments 1 and 2), in lines, from the raw files read again once the
 * payload is built, apart from the routing. U is every line of every captured order whose raw name has a whole metal
 * word (the guard's `metalWord`), whatever became of its order. Each line has an expected place, from the same raw
 * order file its line is read from: `held` when its order is a held record; else `metal` when the title rule reads it
 * as metal (the rule's metal branch first); else `flagged` when the guard flags it; else `drift`. Its actual place is
 * the payload's representation of it: `held` (a line of a held record); `metal` (a metal line of a kept order: the rule
 * accepted it, its `metal` null for a title naming several metals); `flagged` (`metalUncertain` set); `elsewhere` (a
 * non-metal line of a kept order, a competitor's or a skipped order's line, or nowhere). Drift belongs elsewhere.
 */
export interface WalmartGuardCensus {
  /** |U| = heldMetalWordLines + metal + flagged + drift, by construction. */
  universe: number;
  heldMetalWordLines: number;
  metal: number;
  flagged: number;
  drift: number;
  /** Lines whose actual place isn't their expected one: must be 0. */
  omissions: number;
  /** The omissions by `<expected>><actual>` place. */
  omissionsByPlace: Record<string, number>;
  /** Flagged lines by the guard's clause, over its closed clauses (what refused the line, then its first evidence). */
  flaggedByClause: Counts<RetailMetalGuardClause>;
  /** Flagged lines by their first evidence, in the guard's closed order. */
  flaggedByFirstEvidence: Counts<RetailMetalGuardEvidence>;
  /** Flagged lines carrying each evidence at all. */
  flaggedWithEvidence: Counts<RetailMetalGuardEvidence>;
  /** Flagged lines whose only evidence is `adjacency`. */
  adjacencyOnly: number;
  /** Kept orders with a flagged line, and those with a metal line too (mixed). */
  flaggedOrders: number;
  mixedOrders: number;
  /** Held orders with a line the guard would flag: an order count, kept apart from the line identity. */
  heldAlsoFlaggedOrders: number;
}

/** What a conversion found: counts, closed codes, dates and digests only, never a value of a record. */
export interface WalmartConvertReport {
  converter: string;
  source: 'walmart';
  policyVersion: number;
  rules: MetalsRules;
  folder: string;
  schema: string;
  files: number;
  /** The capture's own account of its pull. */
  capture: {
    capturedAt: string;
    /** `exhausted`: the order list's last page had no next cursor; `unstated`: the capture doesn't say. */
    cursor: 'exhausted' | 'unstated';
    listPages: number;
    listRows: number;
    /** A total the site states for the list, or null. */
    siteTotal: number | null;
    details: { captured: number; of: number };
  };
  /**
   * Each order of walmart.json, and each raw detail no order lists, by what became of it. Kept orders (in `orders`) are
   * `metal` (a line the title rule reads as metal, flagged lines beside it or not) or `flagged` (only flagged lots).
   */
  records: {
    read: number;
    metal: number;
    flagged: number;
    competitors: number;
    noCardFunding: number;
    held: number;
    duplicates: { identical: number; differing: number };
  };
  heldByReason: Counts<MetalsHoldReason>;
  heldByCheck: Counts<WalmartHoldCheck>;
  /**
   * Orders that would pass `walmart-order-total@1` (binding aside), and the other card-funded ones: kept orders as
   * `metal`. `withheld`: kept orders whose facts it would admit but whose flagged line keeps them out of card evidence.
   */
  admission: { qualifying: { metal: number; other: number }; aggregate: { metal: number; other: number }; withheld: number };
  /**
   * Items of every order kept, competing or skipped (`items`), and the kept orders' lines: `metal` (the title rule
   * reads it as metal; the by-counts below are of these), `flagged` (metal guard v1's lots) and `nonMetal` (no lot).
   * Titles withheld and product refs count every lot line; `productRefs` splits them by kind.
   */
  lines: {
    items: number;
    metal: number;
    flagged: number;
    nonMetal: number;
    byMetal: Counts<Metal | 'several'>;
    byForm: Counts<MetalForm | 'none'>;
    byPack: Counts<MetalPack>;
    byMassBasis: Counts<MetalsMassBasis>;
    withMass: number;
    withPurity: number;
    withDesign: number;
    titlesWithheld: number;
    /** The titles withheld by why, in storedTitle's order: `text`, `pack-marker`, `metal-guard`. */
    titlesWithheldBy: Counts<WalmartTitleWithheld>;
    productRefsMissing: number;
    productRefs: { metal: WalmartProductRefCounts; flagged: WalmartProductRefCounts };
  };
  /** Every lot line's fine content: known, or held (a flagged line is held `bullion-unconfirmed`). */
  content: { known: number; byBasis: Counts<MetalsFineBasis>; byHold: Counts<MetalsContentHold> };
  /**
   * The kept orders' cost as the allocation rule leaves it. A cancelled lot costs 0 and no tax or fee is ever attributed
   * to it; its completeness is the allocator's, so it is incomplete when its order has a nonzero tax or fee and no line
   * of positive price to carry it (`no-positive-base`): that charge stays unattributed, never in a lot's cost.
   */
  cost: {
    /** Orders with order-level cost no line carries, by the allocation rule's reason (an order counts once per reason). */
    unattributedOrders: Counts<MetalsUnattributedReason>;
    /** Lot lines left incomplete (`cost-unattributed`). */
    incompleteLines: number;
    /** Lots of cancelled groups; those left incomplete, and the orders they are in. */
    cancelledLots: { lots: number; incomplete: number; incompleteOrders: number };
  };
  sellers: { names: number; keys: number; none: number };
  tenders: { byKind: Counts<MetalsTenderKind> };
  events: {
    byKind: { delivered: number; cancelled: number };
    byBasis: { stated: number; 'year-inferred': number; none: number };
    /** Delivered groups whose stated delivery date and status date differ: the stated one is kept. */
    dateDisagreements: number;
    /** Event dates before their order's date, kept as unknown (null) rather than placed. */
    datesBeforeOrder: number;
  };
  rawDetails: { read: number; unlisted: number };
  /** Metal guard v1's census, in lines (WalmartGuardCensus): the run's expectation requires `omissions` 0. */
  census: WalmartGuardCensus;
  /** The owner's questions (Q1): content confirmations the kept orders' unflagged lots need, per product or per lot. */
  confirmations: MetalsConfirmationCounts;
  /** The owner's questions (Q1b): bullion decisions the flagged lots need. */
  bullion: MetalsBullionCounts;
  /** Value-free shapes of what was held or skipped, to find why: counts, closed codes and patterns only. */
  diagnostics: WalmartDiagnostics;
  /** The coverage the payload states, its basis, and the first gap in the list pages' proof (null when it holds). */
  coverage: {
    basis: 'rows read to the pager\'s end' | 'none';
    gap: WalmartCoverageGap | null;
    ranges: MetalsCoverage[];
  };
  dates: { first: string | null; last: string | null };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A held order: its key when its number reads, its date when its records agree on one, the check that held it, and,
 * for the diagnostics only (never written), its number and a reader's first issue as a value-free pattern.
 */
interface Held {
  kind: 'held';
  key: string | null;
  date: string | null;
  check: WalmartHoldCheck;
  id: string | null;
  issue: string | null;
}

/** Facts gathered while converting one kept order, for the report only. */
interface LineFacts {
  titlesWithheld: number;
  titlesWithheldBy: Counts<WalmartTitleWithheld>;
  productRefs: { metal: WalmartProductRefCounts; flagged: WalmartProductRefCounts };
  sellers: { names: number; keys: number; none: number };
  dateDisagreements: number;
  datesBeforeOrder: number;
  /** Why the allocation rule left order-level cost unattributed, each reason once. */
  unattributed: MetalsUnattributedReason[];
}

/**
 * A kept order (`metal`: it has a lot line); `withheld` when its facts would admit card evidence that a flagged line
 * keeps it out of.
 */
type Converted =
  | { kind: 'metal'; key: string; date: string; order: MetalsOrder; facts: LineFacts; items: number; withheld: boolean }
  | { kind: 'competitor'; key: string; date: string; competitor: MetalsCompetitor; tenders: MetalsTender[]; items: number }
  | { kind: 'none'; key: string; date: string; tenders: MetalsTender[]; items: number };
type Outcome = Held | Converted;

/** A check that holds the order it runs on. */
class Hold extends Error {
  constructor(readonly check: WalmartHoldCheck) {
    super(check);
  }
}

const ORDER_ID = /^[0-9]{1,40}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A file's JSON; a file that isn't JSON text refuses the folder (`at` is structural: never the file's name). */
function parseJson(bytes: Uint8Array, at?: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new MetalsConvertError('capture-unreadable', at);
  }
}

/** Canonical JSON: keys sorted at every level, so two readings of one value compare alike. */
function canonical(value: unknown): string {
  const sorted = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sorted);
    if (isRecord(entry)) return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, sorted(entry[key])]));
    return entry;
  };
  return JSON.stringify(sorted(value));
}

/** An order's number as the readers take it (text, or a whole number), or null when it can't be one. */
function orderIdOf(entry: unknown): string | null {
  const id = isRecord(entry) ? entry.orderId : undefined;
  const text = typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? String(id) : id;
  return typeof text === 'string' && ORDER_ID.test(text) ? text : null;
}

/** An order's own date, when it reads, from a consolidated entry that may not read as a whole. */
const listedDateOf = (entry: unknown): string | null => (isRecord(entry) && isCaptureDate(entry.orderDate) ? entry.orderDate : null);

/** A raw detail's own date, when it reads: the date its order date and time starts with. */
function rawDateOf(json: unknown): string | null {
  const order = isRecord(json) && isRecord(json.order) ? json.order : null;
  const stated = order !== null && typeof order.orderDate === 'string' ? order.orderDate.slice(0, 10) : null;
  return isCaptureDate(stated) ? stated : null;
}

const orderKey = (id: string) => metalsNaturalKey('walmart', 'order', [id]);

/**
 * The check a reader's issues hold an order by: a currency other than USD, or otherwise its shape. Issues are classified
 * only, never kept or printed. (A group status outside the closed list is no issue: the readers keep it as data.)
 */
function issuesCheck(issues: readonly CaptureIssue[], shape: 'record-shape' | 'raw-shape'): WalmartHoldCheck {
  const currency = issues.every((issue) => issue.path.endsWith('.currency') && issue.message === 'must be USD');
  return issues.length > 0 && currency ? 'currency' : shape;
}

/**
 * A reader's first issue as a value-free pattern, for the diagnostics: its structural path (schema keys only, since the
 * readers never put an input key in a path) with every index as [*], and its fixed message.
 */
const issuePattern = (issues: readonly CaptureIssue[]): string | null =>
  issues.length === 0 ? null : `${issues[0].path.replace(/\[[0-9]+\]/g, '[*]')}: ${issues[0].message}`;

// ---------------------------------------------------------------------------
// Facts of one order
// ---------------------------------------------------------------------------

const NETWORKS: Readonly<Record<string, MetalsNetwork>> = { VISA: 'visa', MASTERCARD: 'mastercard', AMEX: 'amex', DISCOVER: 'discover' };

/**
 * A payment method as a tender: its kind, network (cards only), last 4 (cards only) and one stated total, or null.
 * PayPal funding is never card funding, whatever the method's type says: it admits no evidence and competes as no card.
 */
function tenderOf(payment: WalmartPayment): MetalsTender {
  const amountMinor = payment.chargedMinor;
  if (payment.paymentType === 'PAYPAL' || payment.cardType === 'PAYPAL') return { kind: 'paypal', network: 'unknown', last4: null, amountMinor };
  switch (payment.paymentType) {
    case 'CREDITCARD':
      return { kind: 'card', network: NETWORKS[payment.cardType ?? ''] ?? 'unknown', last4: payment.last4, amountMinor };
    case 'GIFTCARD':
      return { kind: 'gift-card', network: 'unknown', last4: null, amountMinor };
    case 'CLOSEDLOOP':
      return { kind: 'store-balance', network: 'unknown', last4: null, amountMinor };
  }
}

/**
 * A marketplace seller's label (ROOT's Q6 ruling): its business name with its spaces tidied, when the closed guard passes
 * it, else its one-way key; null when the group names no seller.
 */
function sellerLabel(group: WalmartGroup): { label: string | null; kind: 'names' | 'keys' | 'none' } {
  const name = group.seller?.name?.replace(/\s+/g, ' ').trim() ?? '';
  if (name === '') return { label: null, kind: 'none' };
  return metalsSellerNameProblem(name) === null ? { label: name, kind: 'names' } : { label: metalsSellerKey(name), kind: 'keys' };
}

/** Why a lot line's stored title is withheld, in the order of storedTitle's checks. */
export const WALMART_TITLE_WITHHELD = ['text', 'pack-marker', 'metal-guard'] as const;
export type WalmartTitleWithheld = (typeof WALMART_TITLE_WITHHELD)[number];

/**
 * The title as Holdr stores it: the raw name sanitized (card data redacted, a leading formula sign neutralized, cut to
 * the title limit), or why it is withheld: `text` when the stored-text guard still refuses it; `pack-marker` when the
 * stored text would show a pack marker the raw name, read as a whole, doesn't (the validator's one consistency check);
 * `metal-guard` when a line the guard doesn't flag would store a title metal guard v1 reads as metal-uncertain (the Gold
 * lead's ruling, one name for every source: contract follow-up 1E's one-directional check reads the stored title alone,
 * so no unflagged line may store one that looks flagged). A flagged line keeps its title.
 */
function storedTitle(raw: string, pack: MetalPack, flagged: boolean): { title: string; withheld: null } | { title: null; withheld: WalmartTitleWithheld } {
  const clean = sanitizeCardText(raw, METALS_TITLE_MAX);
  if (clean === null || cardImportTextProblem(clean, METALS_TITLE_MAX) !== null) return { title: null, withheld: 'text' };
  if (pack === 'single' && retailMetalPack(clean) === 'multiple') return { title: null, withheld: 'pack-marker' };
  if (!flagged && retailMetalTitleGuard(clean, { assessed: true }).uncertain) return { title: null, withheld: 'metal-guard' };
  return { title: clean, withheld: null };
}

/** A catalog id's characters, as the contract stores one in a product ref. */
const PRODUCT_REF_ID = /^[A-Za-z0-9_-]+$/;

/**
 * `walmart:<usItemId>`, a public catalog id, or why it is withheld (`absent` when the item states none): exactly what
 * the validator refuses, so a ref is withheld here, never refused there, named by the first of its checks that fails,
 * in its order: the ref's form (`form`, a character outside [A-Za-z0-9_-]; `too-long`, over METALS_PRODUCT_REF_MAX
 * characters), a run of 13 or more digits (`digit-run`), then anything the card-data guard reads as card data.
 */
function productRefOf(item: WalmartItem): { ref: string; withheld: null } | { ref: null; withheld: WalmartProductRefWithheld } {
  const id = item.usItemId;
  if (id === null) return { ref: null, withheld: 'absent' };
  if (!PRODUCT_REF_ID.test(id)) return { ref: null, withheld: 'form' };
  if (id.length > METALS_PRODUCT_REF_MAX) return { ref: null, withheld: 'too-long' };
  const ref = `walmart:${id}`;
  if (/\d{13}/.test(ref)) return { ref: null, withheld: 'digit-run' };
  return containsCardData(ref) ? { ref: null, withheld: 'card-data' } : { ref, withheld: null };
}

const DELIVERED_STATUSES: ReadonlySet<string> = new Set(['DELIVERED', 'PICKED_UP']);

/**
 * A line's one event, from its group's status: delivered (DELIVERED, PICKED_UP) on the stated delivery date, else the
 * status message's date (its year inferred by the capture); cancelled (CANCELED) on the status message's date. A date
 * before the order's own is never placed: the event keeps no date.
 */
function eventOf(group: WalmartGroup, quantity: number, orderDate: string, facts: LineFacts): MetalsEvent {
  const delivered = DELIVERED_STATUSES.has(group.status.type ?? '');
  let date: string | null = null;
  let basis: MetalsDateBasis | null = null;
  if (delivered && group.deliveryDate !== null) {
    date = group.deliveryDate;
    basis = 'stated';
    if (group.status.eventDate !== null && group.status.eventDate !== group.deliveryDate) facts.dateDisagreements += 1;
  } else if (group.status.eventDate !== null) {
    date = group.status.eventDate;
    basis = 'year-inferred';
  }
  if (date !== null && date < orderDate) {
    facts.datesBeforeOrder += 1;
    date = null;
    basis = null;
  }
  return { kind: delivered ? 'delivered' : 'cancelled', date, dateBasis: basis, quantity, occurrence: 1 };
}

// ---------------------------------------------------------------------------
// One order
// ---------------------------------------------------------------------------

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const MAX_LINE_QUANTITY = 100_000;

/** The title rule's evidence on a raw name, under exactly the rule version the payload names. */
function metalEvidenceOf(name: string): RetailMetalEvidence | null {
  const evidence = retailMetalTitleEvidence(name);
  if (evidence !== null && evidence.rule !== METALS_RULES.title) throw new MetalsConvertError('title-rule-mismatch');
  return evidence;
}

/**
 * An item's reading on its RAW name: the title rule's evidence when it reads the name as metal, else metal guard v1's
 * reading of the same raw name, as P5's Costco converter reads a line (the rule first, then the guard on what it
 * refused). Every Walmart line is an item with its name, which the rule reads, so the guard reads it as assessed.
 */
interface LineReading {
  evidence: RetailMetalEvidence | null;
  guard: RetailMetalGuardReading | null;
}

function lineReading(name: string): LineReading {
  const evidence = metalEvidenceOf(name);
  return evidence !== null ? { evidence, guard: null } : { evidence: null, guard: retailMetalTitleGuard(name, { assessed: true }) };
}

/** The flag (`metalUncertain`) of a line the guard reads as metal-uncertain: its guard, its evidence as read, its metal. */
function flagOf(reading: LineReading): MetalsLineMetalUncertain | null {
  const { guard } = reading;
  return guard !== null && guard.uncertain ? { guard: RETAIL_METAL_GUARD, evidence: guard.evidence, metal: guard.metal } : null;
}

/**
 * Converts one order whose consolidated record and raw detail agree: an order with a lot line (metal or flagged), kept
 * in full; a competitor; or an order with no card funding. A check that fails throws Hold.
 */
function convertOrder(order: WalmartOrder, id: string, key: string): Converted {
  const date = order.orderDate;
  if (date === null) throw new Hold('order-date');
  const flags = order.flags;
  if (flags === null) throw new Hold('record-shape');
  const items = order.groups.flatMap((group) => group.items.map((item) => ({ group, item })));
  if (items.length === 0) throw new Hold('items');
  const { amounts } = order;
  if (amounts.subTotalMinor === null) throw new Hold('subtotal');
  if (amounts.taxMinor === null) throw new Hold('tax');
  if (amounts.grandTotalMinor === null) throw new Hold('grand-total');
  if (items.some(({ item }) => item.linePriceMinor === null)) throw new Hold('line-price');
  if (items.some(({ item }) => item.name === null || item.name.trim() === '')) throw new Hold('item-name');
  // Fields the capture has never shown filled: no reviewed rule reads them yet.
  if (amounts.discounts.length > 0) throw new Hold('discounts');
  if (amounts.donations.length > 0) throw new Hold('donations');
  if (amounts.driverTipMinor !== null) throw new Hold('driver-tip');
  if ((order.chargeHistoryEntries ?? 0) > 0) throw new Hold('charge-history');
  if (amounts.taxMinor < 0) throw new Hold('tax-negative');
  if (items.length + amounts.fees.length > METALS_MAX_LINES || order.groups.length > METALS_MAX_LINES) throw new Hold('too-many-lines');
  if (order.payments.length > METALS_MAX_METHODS) throw new Hold('too-many-methods');
  // What a payment method paid is never below zero; Walmart never says a refund went back to a method.
  if (order.payments.some((payment) => payment.chargedMinor !== null && payment.chargedMinor < 0)) throw new Hold('tender-negative');

  const fees = sum(amounts.fees.map((fee) => fee.amountMinor));
  const refunds = sum(amounts.refunds.map((refund) => refund.amountMinor));
  // Walmart's subtotal leaves out a cancelled group's lines, which were never charged: they sit outside the identity, and
  // in the skeleton at amount 0. A subtotal that does include them holds the order.
  const charged = (group: WalmartGroup) => group.status.type !== 'CANCELED';
  if (sum(items.filter(({ group }) => charged(group)).map(({ item }) => item.linePriceMinor!)) !== amounts.subTotalMinor) {
    throw new Hold('subtotal-identity');
  }
  const grossTotalMinor = amounts.subTotalMinor + amounts.taxMinor + fees;
  if (amounts.grandTotalMinor !== grossTotalMinor + refunds) throw new Hold('grand-total-identity');
  if (amounts.grandTotalWithTipsMinor !== null && amounts.grandTotalWithTipsMinor !== amounts.grandTotalMinor) throw new Hold('tips-identity');
  // A full price before refunds below zero is no order's funding: no rule reads it.
  if (grossTotalMinor < 0) throw new Hold('gross-negative');

  const readings = items.map(({ item }) => lineReading(item.name!));
  // A lot line: the title rule reads its name as metal, or metal guard v1 flags it (provisionally bullion, fail-closed).
  const lot = readings.map((reading) => reading.evidence !== null || reading.guard?.uncertain === true);
  // A group's status: one of the closed list, or null when it isn't stated or is outside the list (unread).
  const statuses = order.groups.map((group) => group.status.type);
  const refunded = flags.refunded || amounts.refunds.length > 0 || (order.refundPayments?.length ?? 0) > 0;
  const allCancelled = statuses.every((status) => status === 'CANCELED');
  // A group whose status can't be read may have been cancelled, as surely as one that says so.
  const someCancelled = statuses.some((status) => status === 'CANCELED' || status === null);
  // Read conservatively: any sign of a refund, or a group cancelled or unread, keeps the order out of single-charge
  // admission.
  const facts: MetalsAdmissionFacts = {
    fulfilment: { shipments: order.groups.length },
    methods: order.payments.map(tenderOf),
    refunded,
    cancelled: flags.cancelled || allCancelled,
    partlyCancelled: flags.partlyCancelled || (someCancelled && !allCancelled),
    grossTotalMinor,
  };
  const admission = metalsAdmission('walmart', 'online', facts);
  // An order with no lot line: a competitor when card funding admits it, else nothing. A flagged order never is one.
  if (!lot.includes(true)) {
    if (admission === null) return { kind: 'none', key, date, tenders: facts.methods, items: items.length };
    const competitor: MetalsCompetitor = {
      orderKey: key,
      channel: 'online',
      date,
      interval: metalsSettlementInterval(date, 'online'),
      admission: facts,
      basis: admission.basis,
      capMinor: admission.capMinor,
    };
    return { kind: 'competitor', key, date, competitor, tenders: facts.methods, items: items.length };
  }

  // A lot's lifecycle comes from its group's status alone, so anything that status can't account for holds the order:
  // a status not stated, or outside the closed list. These holds come first: a flagged order is held as a metal one is.
  if (statuses.some((status) => status === null)) throw new Hold('group-status');
  if (order.isInStore === true) throw new Hold('in-store');
  if (flags.returned) throw new Hold('return-lines-unstated');
  if (refunded) throw new Hold('refund-without-return');
  if (flags.partlyCancelled && statuses.every((status) => DELIVERED_STATUSES.has(status!))) throw new Hold('partial-cancel-delivered');
  if (flags.cancelled && statuses.some((status) => DELIVERED_STATUSES.has(status!))) throw new Hold('cancel-delivered');
  const lineIds = new Set<string>();
  for (const [index, { item }] of items.entries()) {
    if (lot[index] && (item.qty === null || item.qty < 1 || item.qty > MAX_LINE_QUANTITY)) throw new Hold('line-quantity');
    if (lot[index] && item.linePriceMinor! < 0) throw new Hold('line-price-negative');
    if (lot[index] && item.lineId === null) throw new Hold('line-id');
    if (item.lineId !== null && lineIds.has(item.lineId)) throw new Hold('line-id');
    if (item.lineId !== null) lineIds.add(item.lineId);
  }

  // The anonymous skeleton: every item (a cancelled group's at amount 0; a lot line, flagged or not, metal), then every
  // order-level fee; the tax is the one component. An amount-0 line has no base, so no tax or fee is ever attributed to
  // a cancelled lot: it costs 0. Its completeness is the allocator's: with no line of positive price to carry a nonzero
  // tax or fee, that charge stays unattributed and every line it could have reached, a cancelled lot included, is
  // incomplete (ROOT's R2 scope).
  const skeleton: MetalsSkeletonLine[] = [
    ...items.map(({ group, item }, ordinal): MetalsSkeletonLine => ({
      ordinal, kind: 'item', amountMinor: charged(group) ? item.linePriceMinor! : 0, shippingMinor: null, feeParent: null, couponTarget: null,
      taxFlag: null, metal: lot[ordinal],
    })),
    ...amounts.fees.map((fee, index): MetalsSkeletonLine => ({
      ordinal: items.length + index, kind: 'fee', amountMinor: fee.amountMinor, shippingMinor: null, feeParent: null, couponTarget: null,
      taxFlag: null, metal: false,
    })),
  ];
  const components = [{ kind: 'tax' as const, amountMinor: amounts.taxMinor }];
  const allocation = metalsAllocation(skeleton, components);
  const noRefs = (): WalmartProductRefCounts => ({ stored: 0, withheld: zeroes(WALMART_PRODUCT_REF_WITHHELD) });
  const lineFacts: LineFacts = {
    titlesWithheld: 0, titlesWithheldBy: zeroes(WALMART_TITLE_WITHHELD), productRefs: { metal: noRefs(), flagged: noRefs() },
    sellers: { names: 0, keys: 0, none: 0 }, dateDisagreements: 0, datesBeforeOrder: 0,
    unattributed: [...new Set(allocation.components.flatMap((component) => (component.reason === null ? [] : [component.reason])))],
  };
  const lines: MetalsLine[] = [];
  items.forEach(({ group, item }, ordinal) => {
    if (!lot[ordinal]) return;
    const found = readings[ordinal].evidence;
    // A flagged line names no metal: the content rule holds it bullion-unconfirmed until the owner decides.
    const flag = flagOf(readings[ordinal]);
    // Every reading is of the raw name, before anything sanitizes, normalizes or cuts it.
    const raw = item.name!;
    const pack = retailMetalPack(raw);
    const observed = metalsTitleObservations(raw);
    const statedMass = found === null || found.statedWeight === null ? null : { value: found.statedWeight.value, unit: found.statedWeight.unit };
    const content: MetalsContentEvidence = {
      source: 'walmart', metal: found?.metal ?? null, form: found?.form ?? null, statedMass, pack,
      purity: observed.purity, massBasis: observed.massBasis, design: observed.design, metalUncertain: flag,
    };
    const stored = storedTitle(raw, pack, flag !== null);
    if (stored.withheld !== null) {
      lineFacts.titlesWithheld += 1;
      lineFacts.titlesWithheldBy[stored.withheld] += 1;
    }
    const productRef = productRefOf(item);
    const refs = lineFacts.productRefs[flag === null ? 'metal' : 'flagged'];
    if (productRef.withheld === null) refs.stored += 1;
    else refs.withheld[productRef.withheld] += 1;
    const seller = sellerLabel(group);
    lineFacts.sellers[seller.kind] += 1;
    const money = allocation.lines.find((line) => line.ordinal === ordinal)!;
    lines.push({
      key: metalsNaturalKey('walmart', 'line', [id, item.lineId!]),
      ordinal,
      title: stored.title,
      productRef: productRef.ref,
      metal: content.metal,
      metalUncertain: flag,
      form: content.form,
      statedMass,
      pack,
      purity: observed.purity,
      massBasis: observed.massBasis,
      design: observed.design,
      contentFingerprint: metalsContentFingerprint(content),
      fine: metalsFineContentWire(metalsFineContent(content)),
      quantity: item.qty!,
      // Walmart states a line's price only; a unit price would be derived, never stated.
      unitPriceMinor: null,
      // A cancelled group's line was never charged: its skeleton amount, 0, and with no tax or fee attributed, cost 0.
      amountMinor: skeleton[ordinal].amountMinor,
      directMinor: money.directMinor,
      allocated: money.allocated,
      costMinor: money.totalMinor,
      netMinor: null,
      complete: money.complete,
      events: [eventOf(group, item.qty!, date, lineFacts)],
      seller: seller.label,
      sale: null,
    });
  });
  const built: MetalsOrder = {
    key,
    side: 'buy',
    channel: 'online',
    date,
    tradeMoment: null,
    completedDate: null,
    currency: 'USD',
    status: null,
    skeleton,
    components,
    admission: facts,
    // A flagged line keeps its order out of card evidence, whatever its funding would admit (the contract's rule).
    evidence: lines.some((line) => line.metalUncertain !== null) ? [] : admission?.evidence ?? [],
    // Shown, never linked: Walmart never says where a refund went. (A refunded metal order is held today.)
    refunds: amounts.refunds.map((refund) => ({ amountMinor: refund.amountMinor, date: null })),
    payouts: [],
    unattributedMinor: allocation.unattributedMinor,
    fullPriceMinor: allocation.fullPriceMinor,
    lines,
  };
  const withheld = built.evidence.length === 0 && (admission?.evidence.length ?? 0) > 0;
  return { kind: 'metal', key, date, order: built, facts: lineFacts, items: items.length, withheld };
}
// ---------------------------------------------------------------------------
// Coverage: the order list's pages, read to the pager's end
// ---------------------------------------------------------------------------

const LIST_PAGE_FILE = /^raw\/list-p([0-9]{3,6})\.json$/;
const DAY_MS = 86_400_000;

/** Why the list pages don't prove the rows read to the pager's end, as closed codes. */
export const WALMART_COVERAGE_GAPS = [
  'no-list-pages',
  'pages-not-contiguous',
  'page-shape',
  'cursor-missing',
  'pager-not-ended',
  'page-short',
  'rows-repeat',
  'provenance-disagrees',
  'list-disagrees',
  'site-total-disagrees',
] as const;
export type WalmartCoverageGap = (typeof WALMART_COVERAGE_GAPS)[number];

interface ListPage {
  /** The page's number as its file names it (`p001`). */
  digits: string;
  json: unknown;
}

/**
 * The rows the order list's pages hold, read to the pager's end, or the first gap in that proof. The pages are
 * `raw/list-p001.json` … `raw/list-pNNN.json` with no gap; each is a page the site answered (`ok`); every page but the
 * last has a next cursor and exactly the list's page size of rows, and the last has none (`nextPageCursor: null`);
 * every row's id is unique; the capture's provenance agrees on pages and rows; and the rows are exactly the distinct
 * orders read from any file. No date order is assumed: the list isn't strictly newest first.
 */
function rowsToPagerEnd(
  pages: readonly ListPage[],
  provenance: WalmartProvenance,
  read: ReadOrders,
): { rows: number } | { gap: WalmartCoverageGap } {
  if (pages.length === 0) return { gap: 'no-list-pages' };
  const ordered = [...pages].sort((a, b) => Number(a.digits) - Number(b.digits) || (a.digits < b.digits ? -1 : a.digits > b.digits ? 1 : 0));
  if (ordered.some((page, index) => page.digits !== String(index + 1).padStart(3, '0'))) return { gap: 'pages-not-contiguous' };
  const ids: string[] = [];
  for (const [index, page] of ordered.entries()) {
    const last = index === ordered.length - 1;
    const history = isRecord(page.json) && page.json.ok === true && isRecord(page.json.purchaseHistory) ? page.json.purchaseHistory : null;
    const info = history !== null && isRecord(history.pageInfo) ? history.pageInfo : null;
    const rows = history !== null && Array.isArray(history.orders) ? history.orders : null;
    if (info === null || rows === null || !('nextPageCursor' in info)) return { gap: 'page-shape' };
    const next = info.nextPageCursor;
    if (next !== null && (typeof next !== 'string' || next === '')) return { gap: 'page-shape' };
    if (!last && next === null) return { gap: 'cursor-missing' };
    if (last && next !== null) return { gap: 'pager-not-ended' };
    if (!last && rows.length !== provenance.list.pageSize) return { gap: 'page-short' };
    for (const row of rows) {
      const id = isRecord(row) ? row.id : undefined;
      if (typeof id !== 'string' || !ORDER_ID.test(id)) return { gap: 'page-shape' };
      ids.push(id);
    }
  }
  const listed = new Set(ids);
  if (listed.size !== ids.length) return { gap: 'rows-repeat' };
  if (provenance.list.pages !== ordered.length || provenance.list.rowsSeen !== ids.length || provenance.list.lastPageHasNext !== false) {
    return { gap: 'provenance-disagrees' };
  }
  // The rows must be exactly the orders read, from any file: an order whose number doesn't read can't be matched.
  if (read.unidentified || read.ids.size !== listed.size || [...read.ids].some((id) => !listed.has(id))) return { gap: 'list-disagrees' };
  return { rows: ids.length };
}

/** The distinct order numbers read from any file (walmart.json and the raw details), and whether one didn't read. */
interface ReadOrders {
  ids: ReadonlySet<string>;
  unidentified: boolean;
}

type CoverageBasis = WalmartConvertReport['coverage']['basis'];

/** Hours after midnight UTC by which every US zone (UTC−4 to UTC−10) has reached the capture's UTC date. */
const US_DAY_REACHED_HOUR = 10;

/**
 * The payload's coverage. `stated` is the rows read to the pager's end (Walmart states no total), only when the list
 * pages prove them; a total the site states is only ever a cross-check on that proof: when it disagrees, or when there
 * is no proof, `stated` is null. `seen` is the distinct orders read from any file; complete only when the two are equal.
 * It runs from the earliest order date read to a fixed end that never claims the capture's own local day in any US
 * zone: the day before the capture's UTC date when the capture is at 10:00Z or later, else two days before.
 */
function coverageOf(
  pages: readonly ListPage[],
  provenance: WalmartProvenance,
  read: ReadOrders,
  dates: readonly string[],
): { basis: CoverageBasis; gap: WalmartCoverageGap | null; range: MetalsCoverage } {
  const proof = rowsToPagerEnd(pages, provenance, read);
  let stated: number | null = 'rows' in proof ? proof.rows : null;
  let gap: WalmartCoverageGap | null = 'gap' in proof ? proof.gap : null;
  const siteTotal = provenance.list.statedTotal;
  if (stated !== null && siteTotal !== null && siteTotal !== stated) {
    stated = null;
    gap = 'site-total-disagrees';
  }
  const basis: CoverageBasis = stated === null ? 'none' : 'rows read to the pager\'s end';
  const capturedDay = provenance.capturedAt.slice(0, 10);
  const daysBack = Number(provenance.capturedAt.slice(11, 13)) >= US_DAY_REACHED_HOUR ? 1 : 2;
  const to = new Date(Date.parse(`${capturedDay}T00:00:00Z`) - daysBack * DAY_MS).toISOString().slice(0, 10);
  const earliest = [...dates].sort()[0];
  const from = earliest !== undefined && earliest < to ? earliest : to;
  const seen = read.ids.size;
  return { basis, gap, range: { kind: 'online', from, to, stated, seen, complete: stated !== null && stated === seen } };
}

// ---------------------------------------------------------------------------
// Metal guard v1's census: the raw files read again, against the payload built from them
// ---------------------------------------------------------------------------

const emptyCensus = (): WalmartGuardCensus => ({
  universe: 0, heldMetalWordLines: 0, metal: 0, flagged: 0, drift: 0, omissions: 0, omissionsByPlace: {},
  flaggedByClause: zeroes(RETAIL_METAL_GUARD_CLAUSES), flaggedByFirstEvidence: zeroes(RETAIL_METAL_GUARD_EVIDENCE),
  flaggedWithEvidence: zeroes(RETAIL_METAL_GUARD_EVIDENCE), adjacencyOnly: 0, flaggedOrders: 0, mixedOrders: 0, heldAlsoFlaggedOrders: 0,
});

/** Where each expected place belongs in the payload: drift is elsewhere (no lot, not held). */
const CENSUS_PLACE: Readonly<Record<WalmartCensusExpected, WalmartCensusActual>> = {
  held: 'held', metal: 'metal', flagged: 'flagged', drift: 'elsewhere',
};

/** One captured order as the census reads it: its key (null when its number doesn't read) and its items' raw names. */
interface CensusOrder {
  key: string | null;
  names: unknown[];
}

/**
 * An order file's item names in item order (its groups, then each group's items), from a consolidated entry or a raw
 * detail (`{ order }`), as the readers take them: a raw item's `productInfo.name` unless absent, else its own `name`.
 * Null when the file shows no readable item name (no groups list, an empty one, or no name that is text), so that the
 * order's other file is read instead, as the diagnostics' title-only read does. A name is kept as it is: only text can
 * hold a metal word.
 */
function censusNames(json: unknown): unknown[] | null {
  const consolidated = !(isRecord(json) && isRecord(json.order));
  const order = consolidated ? json : (json as { order: unknown }).order;
  if (!isRecord(order)) return null;
  const groups = consolidated ? order.groups : order[Object.keys(order).find((key) => key.startsWith('groups')) ?? ''];
  if (!Array.isArray(groups)) return null;
  const names = groups.flatMap((group) => (isRecord(group) && Array.isArray(group.items) ? group.items : [])).map((item) => {
    if (!isRecord(item)) return null;
    if (consolidated) return item.name;
    const info = isRecord(item.productInfo) ? item.productInfo : {};
    return info.name === null || info.name === undefined ? item.name : info.name;
  });
  return names.some((name) => typeof name === 'string' && name.trim() !== '') ? names : null;
}

/**
 * Every captured order once, from the files' bytes parsed again (never the converter's parsed objects): each order the
 * consolidated list names, by its number (repeats are one order), with its lines from its first entry there, or from
 * its raw detail when that entry shows no readable item name; each entry whose number doesn't read; and each raw detail
 * the list doesn't name. An order's lines and their expected places come from that one file.
 */
function censusOrders(files: readonly MetalsCaptureFile[]): CensusOrder[] {
  // The converter has already proved every file JSON text.
  const json = (bytes: Uint8Array): unknown => JSON.parse(decoder.decode(bytes));
  let root: unknown = null;
  const raws = new Map<string, unknown[]>();
  for (const file of files) {
    const detail = RAW_DETAIL_FILE.exec(file.path);
    if (file.path === CONSOLIDATED_FILE) root = json(file.bytes);
    else if (detail !== null) raws.set(detail[1], [...(raws.get(detail[1]) ?? []), json(file.bytes)]);
  }
  const fromRaw = (id: string) => (raws.get(id) ?? []).reduce<unknown[] | null>((found, file) => found ?? censusNames(file), null);
  const orders: CensusOrder[] = [];
  const listed = new Set<string>();
  for (const entry of isRecord(root) && Array.isArray(root.orders) ? root.orders : []) {
    const id = orderIdOf(entry);
    if (id === null) {
      orders.push({ key: null, names: censusNames(entry) ?? [] });
      continue;
    }
    if (listed.has(id)) continue;
    listed.add(id);
    orders.push({ key: orderKey(id), names: censusNames(entry) ?? fromRaw(id) ?? [] });
  }
  for (const id of raws.keys()) if (!listed.has(id)) orders.push({ key: orderKey(id), names: fromRaw(id) ?? [] });
  return orders;
}

/**
 * Where the payload puts the item at `ordinal` of a captured order, by its representation: a line of a held record; a
 * lot of its kept order (metal in the skeleton, and in its lines), flagged or not; else elsewhere.
 */
function censusActual(held: boolean, kept: MetalsOrder | undefined, ordinal: number): WalmartCensusActual {
  if (held) return 'held';
  const item = kept?.skeleton.find((line) => line.ordinal === ordinal && line.kind === 'item');
  const line = kept?.lines.find((entry) => entry.ordinal === ordinal);
  if (item === undefined || !item.metal || line === undefined) return 'elsewhere';
  return line.metalUncertain !== null ? 'flagged' : 'metal';
}

/**
 * The census (WalmartGuardCensus) of a capture's raw files against the payload converted from them. Apart from the
 * routing: each line's expected place is its raw reading's (the order held; else the title rule's metal branch first;
 * else the guard's flag; else drift), and its actual place the payload's.
 */
export function walmartGuardCensus(files: readonly MetalsCaptureFile[], payload: MetalsImportPayload): WalmartGuardCensus {
  const census = emptyCensus();
  const heldKeys = new Set(payload.held.flatMap((record) => (record.key === null ? [] : [record.key])));
  // A held record with no key is an order whose number doesn't read: each answers for one such captured order.
  let unkeyed = payload.held.filter((record) => record.key === null).length;
  const kept = new Map(payload.orders.map((order) => [order.key, order]));
  for (const order of censusOrders(files)) {
    const held = order.key === null ? unkeyed-- > 0 : heldKeys.has(order.key);
    const keptOrder = held || order.key === null ? undefined : kept.get(order.key);
    let flagged = false;
    let metal = false;
    let wouldFlag = false;
    order.names.forEach((name, ordinal) => {
      if (typeof name !== 'string') return;
      const guard = retailMetalTitleGuard(name, { assessed: true });
      if (!guard.metalWord) return;
      census.universe += 1;
      let expected: WalmartCensusExpected;
      if (held) expected = 'held';
      else if (retailMetalTitleEvidence(name) !== null) expected = 'metal';
      else if (guard.uncertain) expected = 'flagged';
      else expected = 'drift';
      census[expected === 'held' ? 'heldMetalWordLines' : expected] += 1;
      if (held && guard.uncertain) wouldFlag = true;
      if (expected === 'metal') metal = true;
      if (expected === 'flagged') {
        flagged = true;
        census.flaggedByClause[guard.clause!] += 1;
        census.flaggedByFirstEvidence[guard.evidence[0]!] += 1;
        for (const kind of guard.evidence) census.flaggedWithEvidence[kind] += 1;
        if (guard.evidence.length === 1 && guard.evidence[0] === 'adjacency') census.adjacencyOnly += 1;
      }
      const actual = censusActual(held, keptOrder, ordinal);
      if (actual !== CENSUS_PLACE[expected]) {
        census.omissions += 1;
        const place = `${expected}>${actual}`;
        census.omissionsByPlace[place] = (census.omissionsByPlace[place] ?? 0) + 1;
      }
    });
    if (flagged) census.flaggedOrders += 1;
    if (flagged && metal) census.mixedOrders += 1;
    if (wouldFlag) census.heldAlsoFlaggedOrders += 1;
  }
  return census;
}

// ---------------------------------------------------------------------------
// The folder
// ---------------------------------------------------------------------------

/** One order of walmart.json: its number and date when they read, its canonical text, and its record or check. */
interface Listed {
  id: string | null;
  date: string | null;
  text: string;
  order: WalmartOrder | null;
  check: WalmartHoldCheck | null;
  /** A reader's first issue, as a value-free pattern (issuePattern), for the diagnostics. */
  issue: string | null;
}

/** One listed order's outcome: held by the first check it fails (on `heldDate`, its records' agreed date), or converted. */
function outcomeOf(id: string, entry: Listed, raws: readonly unknown[], heldDate: string | null): Outcome {
  const key = orderKey(id);
  const held = (check: WalmartHoldCheck, issue: string | null = null): Held => ({ kind: 'held', key, date: heldDate, check, id, issue });
  if (entry.order === null) return held(entry.check ?? 'record-shape', entry.issue);
  try {
    if (raws.length === 0) throw new Hold('raw-missing');
    const [raw] = raws;
    if (raws.some((other) => canonical(other) !== canonical(raw))) throw new Hold('raw-repeats');
    const statedId = isRecord(raw) && isRecord(raw.order) ? raw.order.id : undefined;
    if (statedId !== undefined && statedId !== null && String(statedId) !== id) throw new Hold('raw-id');
    const detail = readWalmartRawDetail(raw, id);
    if (!detail.ok) return held(issuesCheck(detail.issues, 'raw-shape'), issuePattern(detail.issues));
    if (canonical(walmartRawComparable(entry.order)) !== canonical(walmartRawComparable(detail.order))) throw new Hold('raw-disagrees');
    return convertOrder(entry.order, id, key);
  } catch (error) {
    if (error instanceof Hold) return held(error.check);
    throw error;
  }
}

/** The shape of an order held for the subtotal identity, counted into the diagnostics: never a value. */
function countSubtotalShape(order: WalmartOrder, raw: unknown, shape: WalmartSubtotalShapes): void {
  const items = order.groups.flatMap((group) => group.items.map((item) => ({
    cancelled: group.status.type === 'CANCELED', price: item.linePriceMinor ?? 0, qty: item.qty ?? 0,
  })));
  const subtotal = order.amounts.subTotalMinor ?? 0;
  const kept = items.filter((item) => !item.cancelled);
  const lines = sum(kept.map((item) => item.price));
  const difference = Math.abs(lines - subtotal);
  const allExplain = sum(items.map((item) => item.price)) === subtotal;
  const unitExplain = sum(kept.map((item) => item.price * item.qty)) === subtotal;
  shape.held += 1;
  if (lines > subtotal) shape.linesAbove += 1;
  if (lines < subtotal) shape.linesBelow += 1;
  if (items.some((item) => item.cancelled)) shape.withCancelledGroup += 1;
  if (items.some((item) => item.qty > 1)) shape.withQuantityAboveOne += 1;
  if (items.some((item) => item.price === 0)) shape.withZeroPricedLine += 1;
  if (allExplain) shape.allLinesExplain += 1;
  if (unitExplain) shape.unitPricesExplain += 1;
  if (!allExplain && !unitExplain) shape.neitherExplains += 1;
  if (items.some((item) => item.price === difference)) shape.oneLineExplains += 1;
  if (order.amounts.fees.some((fee) => Math.abs(fee.amountMinor) === difference)) shape.oneFeeExplains += 1;
  if (otherPriceFields(raw).some((cents) => Math.abs(cents) === difference)) shape.oneOtherFieldExplains += 1;
}

/** The price fields the raw reader types; any other price field of a raw detail's priceDetails is "other". */
const TYPED_PRICE_FIELDS: ReadonlySet<string> = new Set([
  'subTotal', 'taxTotal', 'grandTotal', 'orderTotal', 'grandTotalWithTips', 'driverTip', 'fees', 'discounts', 'refund', 'donations',
]);

/** Cents of every untyped price field (a price value or a list of them) in a raw detail's priceDetails: never printed. */
function otherPriceFields(raw: unknown): number[] {
  const order = isRecord(raw) && isRecord(raw.order) ? raw.order : null;
  const prices = order !== null && isRecord(order.priceDetails) ? order.priceDetails : null;
  const cents: number[] = [];
  const read = (value: unknown, depth: number) => {
    if (Array.isArray(value) && depth < 2) value.forEach((entry) => read(entry, depth + 1));
    else if (isRecord(value) && typeof value.displayValue === 'string') {
      const shown = displayedCents(value.displayValue);
      if (shown !== null) cents.push(shown);
    }
  };
  if (prices !== null) for (const [field, value] of Object.entries(prices)) if (!TYPED_PRICE_FIELDS.has(field)) read(value, 0);
  return cents;
}

const noMetalLines = (): WalmartMetalLineCounts => ({ orders: 0, delivered: 0, cancelled: 0, other: 0, titleUnread: 0 });
const noSubtotalShapes = (): WalmartSubtotalShapes => ({
  held: 0, linesAbove: 0, linesBelow: 0, withCancelledGroup: 0, withQuantityAboveOne: 0, withZeroPricedLine: 0, allLinesExplain: 0,
  unitPricesExplain: 0, neitherExplains: 0, oneLineExplains: 0, oneFeeExplains: 0, oneOtherFieldExplains: 0,
});
const noHeldFacts = (): WalmartHeldFacts => ({
  orders: 0, withCard: 0, allNonMetalTitles: 0, nonMetalSoundGrandTotal: 0, nonMetalSoundWithCard: 0, dated: 0, fullPriceKnown: 0,
});
const noStatusCounts = (): WalmartStatusCounts => ({ delivered: 0, cancelled: 0, other: 0 });
const noGuardCounts = (): WalmartGuardCounts => ({ orders: 0, lines: noStatusCounts() });
const noFlagCounts = () => ({ metal: noGuardCounts(), none: noGuardCounts(), unread: noGuardCounts() });

/** Counts lines (each in its group-status bucket) into guard counts, and their order once when there is one. */
function countGuardLines(counts: WalmartGuardCounts, buckets: readonly StatusBucket[]): void {
  if (buckets.length === 0) return;
  counts.orders += 1;
  for (const bucket of buckets) counts.lines[bucket] += 1;
}

/** The title rule's words, split exactly as it splits them (NFKC, upper case, runs of A to Z). Diagnostics only. */
const titleRuleWords = (title: string) => title.normalize('NFKC').toUpperCase().split(/[^A-Z]+/).filter((word) => word.length > 0);
/** The rule's bar, coin and round words that need a weight beside them (its other coin words are bullion words). */
const TITLE_SHAPE_WORDS: ReadonlySet<string> = new Set(['BAR', 'BARS', 'COIN', 'COINS', 'ROUND', 'ROUNDS']);

/**
 * Why the title rule reads no metal in a name that has a metal word, as a closed code: `near-miss:<WORD>` (its first
 * word from the rule's closed NEAR_MISS_WORDS); `leaf` (LEAF not right after MAPLE); or, with no bullion word, no design
 * right after a metal word and no shape word with a weight, `design-not-after-metal` (a design word elsewhere),
 * `shape-without-weight` (a bar, coin or round word, so no weight reads), else `no-form-word`. Null when the name has
 * no metal word. Only for a name the rule has refused: it explains a refusal and never reads a name as metal.
 */
export function walmartTitleRefusal(name: string): string | null {
  const words = titleRuleWords(name);
  if (!words.some((word) => METAL_TITLE_WORDS.has(word))) return null;
  const nearMiss = words.find((word) => NEAR_MISS_WORDS.has(word));
  if (nearMiss !== undefined) return `near-miss:${nearMiss}`;
  if (words.some((word, index) => word === 'LEAF' && words[index - 1] !== 'MAPLE')) return 'leaf';
  if (words.some((word) => COIN_DESIGN_WORDS.has(word))) return 'design-not-after-metal';
  if (words.some((word) => TITLE_SHAPE_WORDS.has(word))) return 'shape-without-weight';
  return 'no-form-word';
}

type StatusBucket = keyof WalmartStatusCounts;
/** The capture's own `isPreciousMetal` flags: flagged, not flagged, or unread (a raw detail has no flags). */
type CaptureFlag = 'metal' | 'none' | 'unread';

/** A stated weight as the title rule counts one: a number, then only spaces, dashes or marks, then a unit word. */
const TOKEN_WEIGHT = /\p{N}[\s\p{Pd}\u2212\p{M}]*(?:troy\s*(?:ounces?|oz)|ozt|ounces?|oz|kilograms?|kilos?|kg|grams?|g)(?!\p{L})/iu;
/** The same, in troy units only: TROY OZ, TROY OUNCE(S) or OZT. */
const TOKEN_TROY_WEIGHT = /\p{N}[\s\p{Pd}\u2212\p{M}]*(?:troy\s*(?:ounces?|oz)|ozt)(?!\p{L})/iu;
/** A fineness standing alone as a number: .999 to .99999 (or 0.999), 999, 9999, 999.9, 999.99, or 99.9% to 99.999%. */
const TOKEN_FINENESS = /(?<![\p{N}.,$])(?:0?\.9\p{Nd}{2,4}|9{3,4}(?:\.9{1,2})?|99\.9{1,3}\s?%)(?!\p{N})/u;
/** A karat: one or two digits standing alone (no letter glued before them, as in a model code), then K, KT or KARAT(S). */
const TOKEN_KARAT = /(?<![\p{L}\p{N}.])\p{Nd}{1,2}\s?(?:k|kt|karats?)(?!\p{L})/iu;

/** Which bullion tokens a name carries, besides its words. */
export interface WalmartBullionTokens {
  /** A stated weight in ozt, oz, g or kg: any number right before a unit word, as the title rule counts one. */
  weight: boolean;
  troyWeight: boolean;
  fineness: boolean;
  karat: boolean;
}

/**
 * A name's bullion tokens, read on its NFKC form with invisible format characters dropped. Diagnostics only: they size
 * a fail-closed title guard (a metal word, bullion evidence and a refusal) and test its trigger (tokens with no metal
 * word); they never read a name as metal.
 */
export function walmartBullionTokens(name: string): WalmartBullionTokens {
  const text = [...name].map((character) => (/^\p{Cf}$/u.test(character) ? '' : character.normalize('NFKC'))).join('');
  return {
    weight: TOKEN_WEIGHT.test(text),
    troyWeight: TOKEN_TROY_WEIGHT.test(text),
    fineness: TOKEN_FINENESS.test(text),
    karat: TOKEN_KARAT.test(text),
  };
}

/** An order's item lines by group status, read title-only: names that read as metal, those that don't, and refusals. */
interface TitleRead {
  metal: WalmartStatusCounts;
  nonMetal: number;
  /** Lines with a metal word the rule refused, each with its clause (walmartTitleRefusal). */
  refusals: Array<{ clause: string; bucket: StatusBucket }>;
  /** Of those, the lines with bullion evidence too (a weight, fineness or karat): what a fail-closed guard would hold. */
  guarded: StatusBucket[];
  /** Lines with no metal word but a fineness, karat or troy-weight token, each with its own item's capture flag. */
  unworded: Array<{ bucket: StatusBucket; flag: CaptureFlag }>;
  /** The order's capture flags: some item flagged, none, or unread. */
  flag: CaptureFlag;
}

/**
 * A title-only read of one order file (a consolidated entry, or a raw detail `{ order }`): each item name that is text,
 * through the title rule, by its group's status, and the capture's own item flags when the file is its consolidated
 * entry. Null when no item name can be read at all. Nothing else is read, and nothing read here converts anything.
 */
function titleRead(json: unknown): TitleRead | null {
  const consolidated = !(isRecord(json) && isRecord(json.order));
  const order = consolidated ? json : (json as { order: unknown }).order;
  if (!isRecord(order)) return null;
  const groupsKey = Array.isArray(order.groups) ? 'groups' : Object.keys(order).find((key) => key.startsWith('groups'));
  const groups = groupsKey === undefined ? undefined : order[groupsKey];
  if (!Array.isArray(groups)) return null;
  const read: TitleRead = {
    metal: noStatusCounts(), nonMetal: 0, refusals: [], guarded: [], unworded: [], flag: consolidated ? 'none' : 'unread',
  };
  let names = 0;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.items)) continue;
    const status = isRecord(group.status) ? (group.status.type ?? group.status.statusType) : undefined;
    const bucket: StatusBucket = status === 'DELIVERED' || status === 'PICKED_UP' ? 'delivered' : status === 'CANCELED' ? 'cancelled' : 'other';
    for (const item of group.items) {
      if (!isRecord(item)) continue;
      const itemFlag: CaptureFlag = !consolidated ? 'unread' : item.isPreciousMetal === true ? 'metal' : 'none';
      if (itemFlag === 'metal') read.flag = 'metal';
      const name = isRecord(item.productInfo) && typeof item.productInfo.name === 'string' ? item.productInfo.name : item.name;
      if (typeof name !== 'string' || name.trim() === '') continue;
      names += 1;
      if (metalEvidenceOf(name) !== null) {
        read.metal[bucket] += 1;
        continue;
      }
      read.nonMetal += 1;
      const tokens = walmartBullionTokens(name);
      const clause = walmartTitleRefusal(name);
      if (clause === null) {
        if (tokens.fineness || tokens.karat || tokens.troyWeight) read.unworded.push({ bucket, flag: itemFlag });
        continue;
      }
      read.refusals.push({ clause, bucket });
      if (tokens.weight || tokens.fineness || tokens.karat) read.guarded.push(bucket);
    }
  }
  return names === 0 ? null : read;
}
const metalLineCount = (read: TitleRead) => read.metal.delivered + read.metal.cancelled + read.metal.other;

function countMetalLines(counts: WalmartMetalLineCounts, read: TitleRead | null): void {
  if (read === null) {
    counts.titleUnread += 1;
    return;
  }
  if (metalLineCount(read) > 0) counts.orders += 1;
  counts.delivered += read.metal.delivered;
  counts.cancelled += read.metal.cancelled;
  counts.other += read.metal.other;
}

/** Whether a consolidated record's grand total is subtotal + tax + Σ fees + Σ refunds, every term stated. */
function soundGrandTotal(order: WalmartOrder): boolean {
  const { subTotalMinor, taxMinor, grandTotalMinor, fees, refunds } = order.amounts;
  if (subTotalMinor === null || taxMinor === null || grandTotalMinor === null) return false;
  return grandTotalMinor === subTotalMinor + taxMinor + sum(fees.map((fee) => fee.amountMinor)) + sum(refunds.map((refund) => refund.amountMinor));
}

/** Where a reader's first issue is: in an item, in a group, or elsewhere in the order. */
const issueLevel = (pattern: string): 'item' | 'group' | 'order' =>
  pattern.includes('.items[*]') ? 'item' : pattern.includes('.groups[*]') ? 'group' : 'order';

function emptyReport(capture: MetalsCaptureFolder, provenance: WalmartProvenance): WalmartConvertReport {
  return {
    converter: capture.converterVersion,
    source: 'walmart',
    policyVersion: METALS_CONVERT_POLICY_VERSION,
    rules: { ...METALS_RULES },
    folder: capture.folder,
    schema: WALMART_CAPTURE_SCHEMA,
    files: capture.files.length,
    capture: {
      capturedAt: provenance.capturedAt,
      cursor: provenance.list.lastPageHasNext === false ? 'exhausted' : 'unstated',
      listPages: provenance.list.pages,
      listRows: provenance.list.rowsSeen,
      siteTotal: provenance.list.statedTotal,
      details: { ...provenance.details },
    },
    records: { read: 0, metal: 0, flagged: 0, competitors: 0, noCardFunding: 0, held: 0, duplicates: { identical: 0, differing: 0 } },
    heldByReason: zeroes(METALS_HOLD_REASONS),
    heldByCheck: zeroes(WALMART_HOLD_CHECK_NAMES),
    admission: { qualifying: { metal: 0, other: 0 }, aggregate: { metal: 0, other: 0 }, withheld: 0 },
    lines: {
      items: 0, metal: 0, flagged: 0, nonMetal: 0, byMetal: zeroes([...METALS, 'several'] as const),
      byForm: zeroes([...METAL_FORMS, 'none'] as const), byPack: zeroes(METAL_PACKS), byMassBasis: zeroes(METALS_MASS_BASES), withMass: 0,
      withPurity: 0, withDesign: 0, titlesWithheld: 0, titlesWithheldBy: zeroes(WALMART_TITLE_WITHHELD), productRefsMissing: 0,
      productRefs: {
        metal: { stored: 0, withheld: zeroes(WALMART_PRODUCT_REF_WITHHELD) },
        flagged: { stored: 0, withheld: zeroes(WALMART_PRODUCT_REF_WITHHELD) },
      },
    },
    content: { known: 0, byBasis: zeroes(METALS_FINE_BASES), byHold: zeroes(METALS_CONTENT_HOLDS) },
    cost: { unattributedOrders: zeroes(METALS_UNATTRIBUTED_REASONS), incompleteLines: 0, cancelledLots: { lots: 0, incomplete: 0, incompleteOrders: 0 } },
    sellers: { names: 0, keys: 0, none: 0 },
    tenders: { byKind: zeroes(METALS_TENDER_KINDS) },
    events: { byKind: { delivered: 0, cancelled: 0 }, byBasis: { stated: 0, 'year-inferred': 0, none: 0 }, dateDisagreements: 0, datesBeforeOrder: 0 },
    rawDetails: { read: 0, unlisted: 0 },
    census: emptyCensus(),
    ...metalsOwnerQuestionCounts([]),
    diagnostics: {
      readerIssues: {},
      readerIssueLevels: { item: 0, group: 0, order: 0 },
      skipped: { withMetalNames: 0, byTenderKinds: {} },
      metalLines: { all: noMetalLines(), byOutcome: {} },
      titleRefusals: { orders: 0, all: noStatusCounts(), byOutcome: {}, byClause: {} },
      titleGuard: { ...noGuardCounts(), byOutcome: {}, byOrderFlag: noFlagCounts() },
      tokensWithoutMetalWord: { ...noGuardCounts(), byItemFlag: noFlagCounts() },
      subtotal: { metal: noSubtotalShapes(), other: noSubtotalShapes() },
      held: {},
    },
    coverage: { basis: 'none', gap: null, ranges: [] },
    dates: { first: null, last: null },
  };
}
/**
 * Converts one Walmart account folder's capture. A folder that can't be read as a capture is refused
 * (MetalsConvertError); an order that doesn't hold is held with its check; everything kept is checked once more by
 * the payload validator before it is returned.
 */
export function convertWalmartCapture(capture: MetalsCaptureFolder): MetalsConvertOutput<WalmartConvertReport> {
  if (!WALMART_ACCOUNT_FOLDER.test(capture.folder) || capture.snapshot !== null) throw new MetalsConvertError('folder-mismatch');
  let consolidated: Uint8Array | null = null;
  const pages: ListPage[] = [];
  const raws = new Map<string, unknown[]>();
  for (const file of capture.files) {
    const page = LIST_PAGE_FILE.exec(file.path);
    const detail = RAW_DETAIL_FILE.exec(file.path);
    if (file.path === CONSOLIDATED_FILE && consolidated === null) consolidated = file.bytes;
    else if (page !== null) pages.push({ digits: page[1], json: parseJson(file.bytes, 'raw') });
    else if (detail !== null) raws.set(detail[1], [...(raws.get(detail[1]) ?? []), parseJson(file.bytes, 'raw')]);
    else throw new MetalsConvertError('capture-unreadable', 'files');
  }
  if (consolidated === null) throw new MetalsConvertError('capture-unreadable', 'files');
  const root = parseJson(consolidated);
  if (!isRecord(root)) throw new MetalsConvertError('capture-unreadable', '$');
  if (root.schema !== WALMART_CAPTURE_SCHEMA) throw new MetalsConvertError('schema-unsupported');
  const currency = isRecord(root.provenance) ? root.provenance.currency : undefined;
  if (typeof currency === 'string' && currency.toUpperCase() !== 'USD') throw new MetalsConvertError('currency-unsupported');
  const header = readWalmartCapture({ schema: WALMART_CAPTURE_SCHEMA, provenance: root.provenance, orders: [] });
  if (!header.ok) throw new MetalsConvertError('capture-unreadable', header.issues[0]?.path);
  const provenance = header.capture.provenance;
  if (!Array.isArray(root.orders)) throw new MetalsConvertError('capture-unreadable', '$.orders');
  const entries: unknown[] = root.orders;
  if (entries.length + raws.size > METALS_MAX_ORDERS) throw new MetalsConvertError('too-many-records');

  // Each order is read on its own, so one that doesn't read is held, never the folder.
  const listed = entries.map((entry): Listed => {
    const id = orderIdOf(entry);
    if (id === null) return { id, date: listedDateOf(entry), text: '', order: null, check: 'order-key', issue: null };
    const read = readWalmartCapture({ schema: WALMART_CAPTURE_SCHEMA, provenance: root.provenance, orders: [entry] });
    if (!read.ok) {
      return { id, date: listedDateOf(entry), text: canonical(entry), order: null, check: issuesCheck(read.issues, 'record-shape'), issue: issuePattern(read.issues) };
    }
    const [order] = read.capture.orders;
    return { id, date: order.orderDate, text: canonical(entry), order, check: null, issue: null };
  });

  const report = emptyReport(capture, provenance);
  // Every readable date of every record, by order number: a held order keeps a date only when all its records that state
  // one agree on it (two repeats, or a repeat and its raw detail, that disagree leave it undated, so it bars at any date).
  const observed = new Map<string, Set<string>>();
  const observe = (id: string, date: string | null) => {
    if (date === null) return;
    const found = observed.get(id) ?? new Set<string>();
    found.add(date);
    observed.set(id, found);
  };
  for (const entry of listed) if (entry.id !== null) observe(entry.id, entry.date);
  for (const [id, found] of raws) for (const json of found) observe(id, rawDateOf(json));
  const agreedDate = (id: string): string | null => {
    const found = observed.get(id);
    return found !== undefined && found.size === 1 ? [...found][0] : null;
  };
  // Every readable date read, from any record, whatever became of it: the report's dates and the coverage's start.
  const readDates = [...listed.map((entry) => entry.date), ...[...raws.values()].flat().map(rawDateOf)]
    .filter((date): date is string => date !== null)
    .sort();

  const outcomes: Outcome[] = [];
  const byId = new Map<string, Listed[]>();
  // Each outcome's files, for the diagnostics' title-only read: its consolidated record first, then its raw detail.
  const sources: unknown[][] = [];
  const place = (outcome: Outcome, files: unknown[]) => {
    outcomes.push(outcome);
    sources.push(files);
  };
  listed.forEach((entry, index) => {
    if (entry.id === null) place({ kind: 'held', key: null, date: entry.date, check: 'order-key', id: null, issue: null }, [entries[index]]);
    else byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
  });
  const entryOf = new Map(listed.map((entry, index) => [entry, entries[index]]));
  // One record per order number: identical repeats are one order; repeats that differ hold it.
  for (const [id, group] of byId) {
    const [first] = group;
    const files = [entryOf.get(first), ...(raws.get(id) ?? [])];
    if (group.length > 1 && group.some((entry) => entry.text !== first.text)) {
      report.records.duplicates.differing += group.length - 1;
      place({ kind: 'held', key: orderKey(id), date: agreedDate(id), check: 'duplicate', id, issue: null }, files);
      continue;
    }
    report.records.duplicates.identical += group.length - 1;
    place(outcomeOf(id, first, raws.get(id) ?? [], agreedDate(id)), files);
  }
  // A raw detail no order lists is evidence walmart.json left out: it is held by its own key.
  for (const [id, found] of raws) {
    if (byId.has(id)) continue;
    report.rawDetails.unlisted += 1;
    place({ kind: 'held', key: orderKey(id), date: agreedDate(id), check: 'raw-unlisted', id, issue: null }, found);
  }
  report.rawDetails.read = [...raws.values()].reduce((total, found) => total + found.length, 0);
  report.records.read = entries.length + report.rawDetails.unlisted;

  const orders: MetalsOrder[] = [];
  const competitors: MetalsCompetitor[] = [];
  const held: MetalsHeldRecord[] = [];
  const countTenders = (tenders: readonly MetalsTender[]) => {
    for (const tender of tenders) report.tenders.byKind[tender.kind] += 1;
  };
  for (const outcome of outcomes) {
    if (outcome.kind === 'held') {
      const reason = WALMART_HOLD_CHECKS[outcome.check];
      held.push({ key: outcome.key, channel: 'online', date: outcome.date, reason, check: outcome.check });
      report.records.held += 1;
      report.heldByReason[reason] += 1;
      report.heldByCheck[outcome.check] += 1;
      continue;
    }
    report.lines.items += outcome.items;
    if (outcome.kind === 'none') {
      report.records.noCardFunding += 1;
      countTenders(outcome.tenders);
      continue;
    }
    if (outcome.kind === 'competitor') {
      competitors.push(outcome.competitor);
      report.records.competitors += 1;
      report.admission[outcome.competitor.basis === 'single-charge' ? 'qualifying' : 'aggregate'].other += 1;
      countTenders(outcome.tenders);
      continue;
    }
    const { order, facts } = outcome;
    orders.push(order);
    const flaggedLines = order.lines.filter((line) => line.metalUncertain !== null).length;
    report.records[flaggedLines === order.lines.length ? 'flagged' : 'metal'] += 1;
    countTenders(order.admission!.methods);
    if (order.evidence.length > 0) report.admission.qualifying.metal += 1;
    else if (outcome.withheld) report.admission.withheld += 1;
    else if (order.admission!.methods.some((method) => method.kind === 'card' || method.kind === 'card-refund')) report.admission.aggregate.metal += 1;
    report.lines.nonMetal += outcome.items - order.lines.length;
    for (const reason of facts.unattributed) report.cost.unattributedOrders[reason] += 1;
    let cancelledIncomplete = 0;
    for (const line of order.lines) {
      if (!line.complete) report.cost.incompleteLines += 1;
      if (line.events.some((event) => event.kind === 'cancelled')) {
        report.cost.cancelledLots.lots += 1;
        if (!line.complete) cancelledIncomplete += 1;
      }
    }
    report.cost.cancelledLots.incomplete += cancelledIncomplete;
    if (cancelledIncomplete > 0) report.cost.cancelledLots.incompleteOrders += 1;
    for (const line of order.lines) {
      if ('troyOz' in line.fine) {
        report.content.known += 1;
        report.content.byBasis[line.fine.basis] += 1;
      } else report.content.byHold[line.fine.hold] += 1;
      for (const event of line.events) {
        if (event.kind === 'delivered' || event.kind === 'cancelled') report.events.byKind[event.kind] += 1;
        report.events.byBasis[event.dateBasis === 'stated' || event.dateBasis === 'year-inferred' ? event.dateBasis : 'none'] += 1;
      }
      if (line.metalUncertain !== null) {
        report.lines.flagged += 1;
        continue;
      }
      report.lines.metal += 1;
      report.lines.byMetal[line.metal ?? 'several'] += 1;
      report.lines.byForm[line.form ?? 'none'] += 1;
      report.lines.byPack[line.pack] += 1;
      if (line.massBasis !== null) report.lines.byMassBasis[line.massBasis] += 1;
      if (line.statedMass !== null) report.lines.withMass += 1;
      if (line.purity !== null) report.lines.withPurity += 1;
      if (line.design !== null) report.lines.withDesign += 1;
    }
    report.lines.titlesWithheld += facts.titlesWithheld;
    for (const reason of WALMART_TITLE_WITHHELD) report.lines.titlesWithheldBy[reason] += facts.titlesWithheldBy[reason];
    for (const kind of ['metal', 'flagged'] as const) {
      const into = report.lines.productRefs[kind];
      into.stored += facts.productRefs[kind].stored;
      for (const reason of WALMART_PRODUCT_REF_WITHHELD) {
        into.withheld[reason] += facts.productRefs[kind].withheld[reason];
        report.lines.productRefsMissing += facts.productRefs[kind].withheld[reason];
      }
    }
    report.sellers.names += facts.sellers.names;
    report.sellers.keys += facts.sellers.keys;
    report.sellers.none += facts.sellers.none;
    report.events.dateDisagreements += facts.dateDisagreements;
    report.events.datesBeforeOrder += facts.datesBeforeOrder;
  }

  // Value-free shapes of what was held or skipped, to find why: counts, closed codes and patterns only.
  const { diagnostics } = report;
  outcomes.forEach((outcome, index) => {
    // The first of the order's files whose item names read at all.
    const read = sources[index].reduce<TitleRead | null>((found, file) => found ?? titleRead(file), null);
    const bucket = outcome.kind === 'held' ? `held:${outcome.check}` : outcome.kind === 'metal' ? 'converted' : outcome.kind === 'competitor' ? 'competitor' : 'skipped';
    countMetalLines(diagnostics.metalLines.all, read);
    countMetalLines(diagnostics.metalLines.byOutcome[bucket] ??= noMetalLines(), read);
    if (read !== null) {
      const refusals = diagnostics.titleRefusals;
      if (read.refusals.length > 0) refusals.orders += 1;
      for (const { clause, bucket: status } of read.refusals) {
        refusals.all[status] += 1;
        (refusals.byOutcome[bucket] ??= noStatusCounts())[status] += 1;
        (refusals.byClause[clause] ??= noStatusCounts())[status] += 1;
      }
      const guard = diagnostics.titleGuard;
      countGuardLines(guard, read.guarded);
      if (read.guarded.length > 0) countGuardLines(guard.byOutcome[bucket] ??= noGuardCounts(), read.guarded);
      countGuardLines(guard.byOrderFlag[read.flag], read.guarded);
      const unworded = diagnostics.tokensWithoutMetalWord;
      countGuardLines(unworded, read.unworded.map((line) => line.bucket));
      for (const flag of ['metal', 'none', 'unread'] as const) {
        countGuardLines(unworded.byItemFlag[flag], read.unworded.filter((line) => line.flag === flag).map((line) => line.bucket));
      }
    }
    if (outcome.kind === 'none') {
      if (read !== null && metalLineCount(read) > 0) diagnostics.skipped.withMetalNames += 1;
      const kinds = [...new Set(outcome.tenders.map((tender) => tender.kind))].sort().join('+') || 'none';
      diagnostics.skipped.byTenderKinds[kinds] = (diagnostics.skipped.byTenderKinds[kinds] ?? 0) + 1;
    }
    if (outcome.kind !== 'held') return;
    if (outcome.issue !== null) {
      diagnostics.readerIssues[outcome.issue] = (diagnostics.readerIssues[outcome.issue] ?? 0) + 1;
      diagnostics.readerIssueLevels[issueLevel(outcome.issue)] += 1;
    }
    const order = outcome.id === null ? null : (byId.get(outcome.id)?.[0]?.order ?? null);
    const nonMetal = read !== null && metalLineCount(read) === 0;
    const facts = diagnostics.held[outcome.check] ??= noHeldFacts();
    facts.orders += 1;
    if (order !== null && order.payments.map(tenderOf).some((tender) => tender.kind === 'card')) facts.withCard += 1;
    if (outcome.date !== null) facts.dated += 1;
    if (order !== null && order.amounts.subTotalMinor !== null && order.amounts.taxMinor !== null) facts.fullPriceKnown += 1;
    if (nonMetal) {
      facts.allNonMetalTitles += 1;
      if (order !== null && soundGrandTotal(order)) {
        facts.nonMetalSoundGrandTotal += 1;
        if (order.payments.map(tenderOf).some((tender) => tender.kind === 'card')) facts.nonMetalSoundWithCard += 1;
      }
    }
    if (outcome.check === 'subtotal-identity' && order !== null) {
      countSubtotalShape(order, raws.get(outcome.id!)?.[0], nonMetal ? diagnostics.subtotal.other : diagnostics.subtotal.metal);
    }
  });

  const by = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  orders.sort((a, b) => by(a.date, b.date) || by(a.key, b.key));
  competitors.sort((a, b) => by(a.date, b.date) || by(a.orderKey, b.orderKey));
  held.sort((a, b) => by(a.reason, b.reason) || by(a.check, b.check) || by(a.date ?? '', b.date ?? '') || by(a.key ?? '', b.key ?? ''));
  report.dates = { first: readDates[0] ?? null, last: readDates[readDates.length - 1] ?? null };
  const coverage = coverageOf(pages, provenance, {
    ids: new Set([...listed.flatMap((entry) => (entry.id === null ? [] : [entry.id])), ...raws.keys()]),
    unidentified: listed.some((entry) => entry.id === null),
  }, readDates);
  report.coverage = { basis: coverage.basis, gap: coverage.gap, ranges: [coverage.range] };

  const payload: MetalsImportPayload = {
    format: METALS_IMPORT_FORMAT,
    version: METALS_IMPORT_VERSION,
    source: 'walmart',
    account: { folder: capture.folder, identityLast4: null },
    converterVersion: capture.converterVersion,
    policyVersion: METALS_CONVERT_POLICY_VERSION,
    rules: { ...METALS_RULES },
    input: {
      schema: METALS_CAPTURE_SCHEMAS.walmart,
      captureDigest: metalsDigest(consolidated),
      capturedAt: provenance.capturedAt,
      files: capture.files.length,
    },
    coverage: [coverage.range],
    orders,
    competitors,
    held,
  };
  report.census = walmartGuardCensus(capture.files, payload);
  Object.assign(report, metalsOwnerQuestionCounts(payload.orders));
  return metalsConvertOutput(payload, report);
}

/** `holdr-metals-convert --source walmart`: an account folder's walmart.json, list pages and raw details. */
export const walmartCaptureConverter: MetalsCaptureConverter = {
  input: 'capture-folder',
  source: 'walmart',
  folder: WALMART_ACCOUNT_FOLDER,
  files: [
    { dir: '', name: /^walmart\.json$/, required: true },
    { dir: 'raw', name: /^list-p[0-9]{3,6}\.json$/, required: false },
    { dir: 'raw', name: /^detail-[0-9]{1,40}\.json$/, required: false },
  ],
  convert: convertWalmartCapture,
};