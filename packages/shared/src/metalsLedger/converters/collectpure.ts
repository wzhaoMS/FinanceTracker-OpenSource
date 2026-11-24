/**
 * The CollectPure converter, `collectpure@1` (design v8 §5.4): one CollectPure account's capture folder
 * (`holdr-retail-capture/collectpure@1`) as a `holdr.metals-import` v1 payload of sales, with a value-free report.
 * Pure: the CLI reads the folder's files (each listed in the owner's manifest) and hands their bytes in; nothing here
 * touches a file system, network or clock.
 *
 * Reads `collectpure.json`, `raw/sell-order-<id>.json`, `raw/payout-history-pNN.json` and the stats files
 * (`raw/sell-stats.json`, `raw/buy-stats.json`, `raw/inventory-stats.json`). A snapshot nested in the account folder
 * (`snap<yyyymmdd>`) is converted on its own and names its account folder.
 *
 * - Trade moment: `placedAt`, a UTC instant, which must equal the first timeline step ("Order Placed"). The agreed day
 *   is its New York date (the contract's metalsNewYorkDate), which must equal the capture's `placedDateNY`. The page's `orderDate` (a UTC
 *   calendar date) and `completeAt` are never used, and a page that states a price lock holds the order.
 * - Each sale line is a disposition when the title rule names a metal in its raw product name, gold and silver alike:
 *   the pack, purity, mass basis and design are read from that raw name. The dealer's stated spot premium is stored in
 *   one closed form built from its two stated figures (premiumOf). A line the rule refuses, whose raw name names a metal
 *   as a whole word and shows bullion evidence, is flagged by metal guard v1 (`metalUncertain`): a disposition with no
 *   metal of its own, held `bullion-unconfirmed`, and a metal line of the skeleton, so its sale is carried in full.
 *   Any other line stays an anonymous non-metal line of the skeleton; a sale with neither a metal nor a flagged line
 *   holds. Holds come first: a flag never releases or replaces a hold. A stored title is checked last: on a line the
 *   guard doesn't flag, a stored title the guard would flag is withheld (`metal-guard`), never stored to read otherwise.
 * - The report's guard census reads the raw files again once the payload is built, and checks every line whose raw name
 *   holds a whole metal word against where the payload put it (guardCensus).
 * - Money: Σ line totals = subtotal, quantity × unit price = line total, subtotal − insured shipping − platform fee =
 *   total payout, and on a complete sale total payout = Σ payout transactions. The site states both deductions signed,
 *   as its page shows them (zero or negative), so the identity reads subtotal + shipping + processingFee = total, and
 *   they are the sale's two negative components as stated; one stated positive holds the order. The one optional fee
 *   a real sale states restates its platform fee: taken so only when it is the only one, negative, equal to the cent to
 *   the platform fee and the page's Platform Fee row, with the identity counting the fee once (ROOT's ruling), it is
 *   neither a component nor counted nor stored, and the report counts such sales. Any other optional fee, promotions,
 *   sales tax, an instant payout advance and combined sell orders have no reviewed rule, so each holds the order.
 * - Payouts: ACH only ('ach' on the order, 'ACH' on each transaction), status 'complete' only; each transaction must
 *   agree with the consolidated payouts list and with the raw payout-history pages.
 * - Holds: every reason and check is a closed code (COLLECTPURE_HOLD_CHECKS). A held sale keeps its date: placedAt's
 *   New York date whenever placedAt reads, else the stated placedDateNY. Buy orders, inventory rows and a vault are
 *   held too: v1 has no buy side at CollectPure.
 * - Coverage: sell orders by the site's stated total (the sell stats and the list's total, which must agree); payouts
 *   by the rows read to the pager's end, since the site states no payouts total.
 *
 * Nothing it reports or throws carries a value: counts, closed codes, dates and digests only.
 */

import { containsCardData } from '../../cardNumbers.js';
import { cardImportTextProblem, sanitizeCardText } from '../../cardImport.js';
import { retailMetalPack } from '../../retailImportTool/metalPackRule.js';
import {
  RETAIL_METAL_GUARD,
  RETAIL_METAL_GUARD_CLAUSES,
  RETAIL_METAL_GUARD_EVIDENCE,
  RETAIL_METAL_TITLE_RULE,
  retailMetalTitleEvidence,
  retailMetalTitleGuard,
  type RetailMetalEvidence,
  type RetailMetalGuardClause,
  type RetailMetalGuardEvidence,
  type RetailMetalGuardReading,
} from '../../retailImportTool/metalTitleRule.js';
import { metalsAllocation } from '../allocation.js';
import { CAPTURE_MAX_ISSUES, canonicalStamp, isCaptureDate, isRecord, type CaptureIssue } from '../captures/captureRead.js';
import {
  COLLECTPURE_TIMELINE_STATUSES,
  collectPureRawComparable,
  readCollectPureCapture,
  readCollectPureInventoryStats,
  readCollectPureOrderStats,
  readCollectPurePayoutHistoryPage,
  readCollectPureRawSellOrder,
  type CollectPureCapture,
  type CollectPureCaptureForm,
  type CollectPureLine,
  type CollectPurePayout,
  type CollectPurePayoutHistoryItem,
  type CollectPurePayoutTransaction,
  type CollectPureRawStated,
  type CollectPureSellOrder,
  type CollectPureStatsCounts,
  type CollectPureStatusKey,
  type CollectPureTimelineStatus,
} from '../captures/collectpureCapture.js';
import { metalsContentFingerprint, metalsFineContent, metalsFineContentWire, type MetalsContentEvidence } from '../contentRule.js';
import {
  METALS_CAPTURE_SCHEMAS,
  METALS_CONVERT_POLICY_VERSION,
  METALS_IMPORT_FORMAT,
  METALS_IMPORT_VERSION,
  METALS_RULES,
  METALS_SELL_STATUSES,
  type MetalPack,
  type MetalsEvent,
  type MetalsEventKind,
  type MetalsHoldReason,
  type MetalsInspection,
  type MetalsLineMetalUncertain,
  type MetalsPremiumBasis,
  type MetalsOrderComponent,
  type MetalsSellStatus,
  type MetalsSkeletonLine,
} from '../model.js';
import { metalsTitleObservations } from '../observations.js';
import {
  METALS_MAX_ORDERS,
  METALS_PRODUCT_REF_MAX,
  METALS_TITLE_MAX,
  metalsDigest,
  metalsNaturalKey,
  metalsNewYorkDate,
  validateMetalsImportPayload,
  type MetalsCoverage,
  type MetalsHeldRecord,
  type MetalsImportPayload,
  type MetalsLine,
  type MetalsOrder,
  type MetalsPayout,
} from '../payload.js';
import {
  MetalsConvertError,
  metalsConvertOutput,
  metalsOwnerQuestionCounts,
  type MetalsCaptureConverter,
  type MetalsCaptureFile,
  type MetalsCaptureFiles,
  type MetalsCaptureFolder,
  type MetalsConvertOutput,
  type MetalsOwnerQuestionCounts,
} from './common.js';

/** This converter's name in reports: the capture schema it reads, at its version. */
export const COLLECTPURE_CONVERTER_NAME = 'collectpure@1' as const;
/** An account folder's name, as the payload names it: `collectpure`, `collectpure-2`, … */
export const COLLECTPURE_ACCOUNT_FOLDER = /^collectpure(?:-[1-9][0-9]{0,2})?$/;
/** A snapshot nested in an account folder: `snap<yyyymmdd>`. */
export const COLLECTPURE_SNAPSHOT_FOLDER = /^snap[0-9]{8}$/;

const CONSOLIDATED_NAME = /^collectpure\.json$/;
const SELL_ORDER_NAME = /^sell-order-([A-Za-z0-9_-]{1,64})\.json$/;
const PAYOUT_PAGE_NAME = /^payout-history-p([0-9]{2,4})\.json$/;
const STATS_NAME = /^(sell|buy|inventory)-stats\.json$/;

/** Every file the converter reads, all in the given folder; a nested snapshot folder is never read from its base. */
export const COLLECTPURE_CAPTURE_LAYOUT: readonly MetalsCaptureFiles[] = [
  { dir: '', name: CONSOLIDATED_NAME, required: true },
  { dir: 'raw', name: SELL_ORDER_NAME, required: false },
  { dir: 'raw', name: PAYOUT_PAGE_NAME, required: false },
  { dir: 'raw', name: STATS_NAME, required: false },
];

/** Every check a hold may name, by its reason: closed codes, never a value. */
export const COLLECTPURE_HOLD_CHECKS = {
  'unreadable': ['sell-order-shape', 'raw-json', 'raw-shape'],
  'status-unknown': ['status-key'],
  'duplicate-in-capture': ['sell-order-id', 'line-id', 'payout-id'],
  'raw-missing': ['raw-sell-order'],
  'capture-disagreement': [
    'raw-detail', 'trade-moment', 'agreed-day', 'step-date', 'payout-list', 'payout-history', 'payout-date-order', 'total-paid',
    'raw-without-listing', 'payout-without-sell-order',
  ],
  'field-missing': ['placed-at', 'placed-date-ny', 'first-step', 'status', 'lines', 'payout-date'],
  'field-unsupported': [
    'price-lock', 'optional-fee', 'promotion', 'sales-tax', 'instant-payout-advance', 'combined-sell-order',
    'negative-price', 'positive-deduction', 'inspection-value', 'no-metal-line', 'payload-contract',
  ],
  'quantity-unknown': ['line-quantity'],
  'identity-failed': ['line-total', 'subtotal', 'payout-identity', 'paid-total'],
  'status-ambiguous': ['timeline-order', 'timeline-incomplete', 'timeline-ahead', 'line-pending', 'cancelled-with-payout'],
  'inspection-failed': ['inspection'],
  'payout-unsupported': ['payout-method', 'payout-status', 'payout-amount'],
  'buy-side-unsupported': ['buy-order', 'inventory-row'],
  'vault-unsupported': ['vault-enabled', 'vault-holding'],
} as const satisfies Partial<Record<MetalsHoldReason, readonly string[]>>;
type HoldReason = keyof typeof COLLECTPURE_HOLD_CHECKS;
type HoldCheck<R extends HoldReason> = (typeof COLLECTPURE_HOLD_CHECKS)[R][number];

/** What the payouts' and the sell orders' stated counts are, named wherever a count appears (Gold lead's ruling). */
export const COLLECTPURE_COVERAGE_BASES = {
  'sell-orders': "the site's stated total: the sell stats' total, equal to the sell-orders list's total",
  'payouts': "rows read to the pager's end: the site states no payouts total",
} as const;

/** Why a coverage's stated count is unknown (null), as closed codes. */
export const COLLECTPURE_COVERAGE_GAPS = [
  'sell-orders-page-missing', 'sell-stats-missing', 'stated-totals-disagree', 'payout-pages-missing', 'pager-incomplete',
  'payout-ids-repeat', 'pager-provenance-disagrees',
] as const;
export type CollectPureCoverageGap = (typeof COLLECTPURE_COVERAGE_GAPS)[number];

export type CollectPureCoverageReport = MetalsCoverage & { statedBasis: string; statedUnknownBecause: CollectPureCoverageGap | null };

/** The guard census's counts, in lines: `universe` = `heldMetalWordLines` + `metal` + `flagged` + `drift`. */
export interface CollectPureGuardCensus {
  universe: number;
  heldMetalWordLines: number;
  metal: number;
  flagged: number;
  drift: number;
  /** Lines whose position in the payload isn't their expected one: a counts-only run requires 0. */
  omissions: number;
  /** The omissions by `<expected>><actual>` position (actual: held, metal, flagged, drift or elsewhere). */
  omissionsByPlace: Record<string, number>;
}

/** A conversion's report: counts, closed codes, dates and digests only. */
export type CollectPureConvertReport = {
  converter: typeof COLLECTPURE_CONVERTER_NAME;
  snapshot: boolean;
  capture: { capturedAt: string; captureDigest: string; files: number };
  sellOrders: {
    listed: number;
    converted: number;
    held: number;
    byStatus: Record<MetalsSellStatus, number>;
    agreedDays: { first: string; last: string } | null;
  };
  lines: {
    /** Lines kept in sales as dispositions: the title rule's metal lines and the guard's flagged lines. */
    dispositions: number;
    /** Lines kept in sales as anonymous non-metal skeleton lines. */
    nonMetal: number;
    /** The title rule's metal lines, by metal (`none`: a title naming several metals). Flagged lines count in `guard`. */
    byMetal: Record<string, number>;
    byPack: Record<MetalPack, number>;
    /** By fine-content authority, or by the hold that names the first missing step. */
    byContent: Record<string, number>;
    /** Stored texts kept, by field: with `withheld`, a line that states none of a text counts in neither. */
    stored: { title: number; productRef: number; program: number; premium: number };
    /** Stored texts left out because the card-data guard or the payload's text rules refuse them. */
    withheld: { title: number; productRef: number; program: number; premium: number };
    /**
     * Product refs by the kind of line (the title rule's metal lines, the guard's flagged lines): stored, or withheld
     * and why (COLLECTPURE_PRODUCT_REF_WITHHELD). `stored.productRef` and `withheld.productRef` above total them, a line
     * that states no SKU (`absent`) counting in neither.
     */
    productRefs: { metal: CollectPureProductRefCounts; flagged: CollectPureProductRefCounts };
    /** Titles withheld, by why (COLLECTPURE_TITLE_WITHHELD): they sum to `withheld.title`. */
    titlesWithheld: Record<CollectPureTitleWithheld, number>;
  };
  /**
   * Metal guard v1 on the kept sales' lines, each read on its raw product name: lines flagged, by clause (all 30 closed
   * clauses) and by first evidence kind, how many carry each evidence kind at all, flags whose only evidence is
   * adjacency, sales with a flagged line (and how many of them also hold a metal line), and held sales with a line the
   * guard would flag.
   */
  guard: {
    flaggedLines: number;
    byClause: Record<RetailMetalGuardClause, number>;
    byFirstEvidence: Record<RetailMetalGuardEvidence, number>;
    byEvidence: Record<RetailMetalGuardEvidence, number>;
    adjacencyOnly: number;
    flaggedOrders: number;
    mixedOrders: number;
    heldAlsoFlaggedOrders: number;
  };
  /**
   * The guard census, in lines (guard-integration spec): every captured line whose raw product name holds a whole metal
   * word, by its expected position (held, then the rule's metal, then flagged, then drift), so that `universe` is their
   * sum; and the lines whose position in the payload differs from the expected one (`omissions`).
   */
  census: CollectPureGuardCensus;
  /**
   * The owner's questions over the payload's lots (the shared metalsOwnerQuestionCounts): Q1's confirmations and Q1b's
   * bullion decisions. A lot is a line of a buy order, so a CollectPure payload, which holds sales only, counts none.
   */
  confirmations: MetalsOwnerQuestionCounts['confirmations'];
  bullion: MetalsOwnerQuestionCounts['bullion'];
  payouts: { listed: number; unreadableRows: number; historyPages: number; historyRows: number; converted: number };
  /**
   * Sales by their optional fees, held later or not: none stated, or one taken as the platform fee restated (ROOT's
   * ruling). A sale whose optional fee is anything else is held `field-unsupported/optional-fee`, and counted there.
   */
  optionalFees: { none: number; restatedPlatformFee: number };
  rawSellOrders: { files: number; withoutListing: number };
  /** `reason/check` → how many records. */
  held: Record<string, number>;
  /** The payload validator's first issue for each sale held `payload-contract`: a structural path and fixed text. */
  contractIssues: Array<{ path: string; message: string }>;
  coverage: CollectPureCoverageReport[];
};

// ---------------------------------------------------------------------------
// Holds and stored text
// ---------------------------------------------------------------------------

/** A sale that is held instead of converted: thrown by the checks, caught per sale. */
class Hold extends Error {
  constructor(readonly reason: HoldReason, readonly check: string) {
    super(check);
  }
}

function hold<R extends HoldReason>(reason: R, check: HoldCheck<R>): never {
  throw new Hold(reason, check);
}

const SHORT_TEXT = /^[\x20-\x7E]{1,60}$/;
const SHORT_TEXT_MAX = 60;

/** Free text as the payload stores it, through the card-data guard, or null; `withheld` when the guard refused it. */
function storedText(raw: string | null, maxLength: number): { text: string | null; withheld: boolean } {
  if (raw === null || raw.trim() === '') return { text: null, withheld: false };
  let clean: string | null;
  try {
    clean = sanitizeCardText(raw, maxLength);
  } catch {
    return { text: null, withheld: true };
  }
  if (clean === null) return { text: null, withheld: false };
  return cardImportTextProblem(clean, maxLength) === null ? { text: clean, withheld: false } : { text: null, withheld: true };
}

/**
 * A sale's program as the payload's rules take short text: printable ASCII within 60 characters, no card data, no run
 * of five digits, no `@`; a leading formula character is neutralized with `'`. Otherwise withheld.
 */
function shortText(raw: string | null): { text: string | null; withheld: boolean } {
  const { text, withheld } = storedText(raw, SHORT_TEXT_MAX);
  if (text === null) return { text: null, withheld };
  const refused = !SHORT_TEXT.test(text) || containsCardData(text) || /\d{5}/.test(text) || text.includes('@');
  return refused ? { text: null, withheld: true } : { text, withheld: false };
}

/** The words each premium basis takes in the stored premium text. */
const PREMIUM_BASIS_WORDS: Readonly<Record<MetalsPremiumBasis, string>> = { troy_ounce: 'troy ounce', unit: 'unit' };
/** A premium this large, in percent over spot, is no premium a dealer states: it is withheld. */
const PREMIUM_PERCENT_LIMIT = 1_000;

/** Cents as signed dollars with thousands separators: `+$1,234.56`, `-$40.13`, `+$0.00`. */
function signedDollars(cents: number): string {
  const size = Math.abs(cents);
  const whole = String(Math.floor(size / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : '+'}$${whole}.${String(size % 100).padStart(2, '0')}`;
}

/**
 * The dealer's stated spot premium, as the payload stores it: one closed form built from CollectPure's two stated
 * figures, never their raw text (the percent is an unrounded float that no stored-text rule takes):
 *
 *   `spot ±P% / ±$D per troy ounce|unit`
 *
 * P is `spotPremium`, the percent over spot, to four decimals; D is `spotPremiumDollar`, its amount in exact cents on
 * the line's basis (per troy ounce or per unit, as `premiumCalculationType` says, which is also the payload's basis).
 * Withheld (null, and counted) unless P is a number under 1,000 in size, D and the basis are stated, and P and D have
 * the same sign (both zero, or both positive, or both negative). A line that states neither has no premium.
 */
function premiumOf(line: CollectPureLine): { premium: { text: string; basis: MetalsPremiumBasis } | null; withheld: boolean } {
  const percent = line.spotPremiumRaw;
  const cents = line.spotPremiumDollarMinor;
  const basis = line.premiumCalculationType;
  if (percent === null && cents === null) return { premium: null, withheld: false };
  if (typeof percent !== 'number' || cents === null || basis === null || Math.abs(percent) >= PREMIUM_PERCENT_LIMIT) {
    return { premium: null, withheld: true };
  }
  if (!((percent > 0 && cents > 0) || (percent < 0 && cents < 0) || (percent === 0 && cents === 0))) return { premium: null, withheld: true };
  // The bound applies to the percent as stored: 999.99999 rounds to 1000.0000, outside the form.
  const rounded = Math.abs(percent).toFixed(4);
  if (Number(rounded) >= PREMIUM_PERCENT_LIMIT) return { premium: null, withheld: true };
  const text = `spot ${percent < 0 ? '-' : '+'}${rounded}% / ${signedDollars(cents)} per ${PREMIUM_BASIS_WORDS[basis]}`;
  // The form always passes the short-text rules; a premium that somehow doesn't is withheld, never stored altered.
  return shortText(text).text === text ? { premium: { text, basis }, withheld: false } : { premium: null, withheld: true };
}

/**
 * Why a line's stored title is withheld (closed, and counted in the report): `text`, the stored-text guard refuses it;
 * `pack-marker`, it would show a pack marker its raw name doesn't; `metal-guard`, on a line metal guard v1 doesn't
 * flag, the guard would flag the stored title itself (contract follow-up 1E's one-directional check, run last).
 */
export const COLLECTPURE_TITLE_WITHHELD = ['text', 'pack-marker', 'metal-guard'] as const;
export type CollectPureTitleWithheld = (typeof COLLECTPURE_TITLE_WITHHELD)[number];

/**
 * The line's stored title, or null and why (COLLECTPURE_TITLE_WITHHELD). Last, on the final stored title, contract
 * follow-up 1E's one-directional check: on a line the guard doesn't flag (its raw name read), a stored title the guard
 * would flag is withheld, since a cut or sanitized title can read otherwise than its raw name. A flagged line keeps its
 * title, and a stored title never sets or clears a flag: every fact of the line, its flag included, is read on its raw
 * name.
 */
function storedTitle(raw: string | null, pack: MetalPack, flagged: boolean): { text: string | null; withheld: CollectPureTitleWithheld | null } {
  const stored = storedText(raw, METALS_TITLE_MAX);
  if (stored.text === null) return { text: null, withheld: stored.withheld ? 'text' : null };
  if (pack === 'single' && retailMetalPack(stored.text) === 'multiple') return { text: null, withheld: 'pack-marker' };
  if (!flagged && retailMetalTitleGuard(stored.text, { assessed: true }).uncertain) return { text: null, withheld: 'metal-guard' };
  return { text: stored.text, withheld: null };
}

/** A catalog id's characters, as the contract takes them in a product ref (`collectpure:<sku>`). */
const PRODUCT_REF_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Why a line's product ref is withheld (G1b-int's reasons for Walmart): `absent`, the line states no SKU; else the first
 * of the contract validator's checks the ref fails, in its order (payload.ts): the SKU's characters (`form`, one outside
 * [A-Za-z0-9_-]), its length (`too-long`, over METALS_PRODUCT_REF_MAX, which bounds the catalog id, not the prefixed
 * ref), a run of 13 or more digits (`digit-run`), then anything that could be read as card data (`card-data`).
 */
export const COLLECTPURE_PRODUCT_REF_WITHHELD = ['absent', 'form', 'too-long', 'digit-run', 'card-data'] as const;
export type CollectPureProductRefWithheld = (typeof COLLECTPURE_PRODUCT_REF_WITHHELD)[number];

/** A kind of line's product refs: stored, or withheld and why. Stored plus every reason is that kind's lines. */
export interface CollectPureProductRefCounts {
  stored: number;
  withheld: Record<CollectPureProductRefWithheld, number>;
}

/** `collectpure:<sku>`, or null and why (COLLECTPURE_PRODUCT_REF_WITHHELD): withheld exactly when the validator would refuse it. */
function productRefOf(sku: string | null): { ref: string; withheld: null } | { ref: null; withheld: CollectPureProductRefWithheld } {
  if (sku === null) return { ref: null, withheld: 'absent' };
  if (!PRODUCT_REF_ID.test(sku)) return { ref: null, withheld: 'form' };
  if (sku.length > METALS_PRODUCT_REF_MAX) return { ref: null, withheld: 'too-long' };
  const ref = `collectpure:${sku}`;
  if (/\d{13}/.test(ref)) return { ref: null, withheld: 'digit-run' };
  if (containsCardData(ref)) return { ref: null, withheld: 'card-data' };
  return { ref, withheld: null };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

type Parsed = { ok: true; json: unknown } | { ok: false };

const decoder = new TextDecoder('utf-8', { fatal: true });
function parseJson(bytes: Uint8Array): Parsed {
  try {
    return { ok: true, json: JSON.parse(decoder.decode(bytes)) };
  } catch {
    return { ok: false };
  }
}

interface FolderFiles {
  consolidated: MetalsCaptureFile;
  /** By the sell order's id, from the file's name. */
  rawSellOrders: Map<string, MetalsCaptureFile>;
  /** By page number, from 1. */
  payoutPages: Map<number, MetalsCaptureFile>;
  stats: Map<'sell' | 'buy' | 'inventory', MetalsCaptureFile>;
}

/** The folder's files by kind. A file outside the layout, or a path given twice, refuses the folder. */
function folderFiles(files: readonly MetalsCaptureFile[]): FolderFiles {
  let consolidated: MetalsCaptureFile | null = null;
  const rawSellOrders = new Map<string, MetalsCaptureFile>();
  const payoutPages = new Map<number, MetalsCaptureFile>();
  const stats = new Map<'sell' | 'buy' | 'inventory', MetalsCaptureFile>();
  const paths = new Set<string>();
  files.forEach((file, index) => {
    const at = `files[${index}]`;
    if (paths.has(file.path)) throw new MetalsConvertError('capture-layout', at);
    paths.add(file.path);
    if (CONSOLIDATED_NAME.test(file.path)) {
      consolidated = file;
      return;
    }
    const name = file.path.startsWith('raw/') ? file.path.slice(4) : null;
    const sellOrder = name === null ? null : SELL_ORDER_NAME.exec(name);
    const page = name === null ? null : PAYOUT_PAGE_NAME.exec(name);
    const statsFile = name === null ? null : STATS_NAME.exec(name);
    if (sellOrder) rawSellOrders.set(sellOrder[1], file);
    else if (page && !payoutPages.has(Number(page[1]))) payoutPages.set(Number(page[1]), file);
    else if (statsFile) stats.set(statsFile[1] as 'sell' | 'buy' | 'inventory', file);
    else throw new MetalsConvertError('capture-layout', at);
  });
  if (consolidated === null) throw new MetalsConvertError('capture-layout', 'files');
  return { consolidated, rawSellOrders, payoutPages, stats };
}

// ---------------------------------------------------------------------------
// The consolidated file, with unreadable sell orders set aside
// ---------------------------------------------------------------------------

const SELL_ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SELL_ORDER_PATH = /^\$\.sellOrders\[(\d+)\](?=$|[.[])/;
const PAYOUT_ROW_PATH = /^\$\.payouts\[(\d+)\](?=$|[.[])/;
const REPEATED_ID = "repeats an earlier sell order's id";
/** The reader's fixed messages for a value outside a closed list, and for a missing one. */
const NOT_ALLOWED = 'is not one of the allowed values';
const MISSING = 'is missing';

interface ConsolidatedRead {
  capture: CollectPureCapture;
  /** Sell orders the file lists that can't be read, as holds. */
  unreadable: MetalsHeldRecord[];
  /** Every sell-order id the file lists, read or not. */
  listedIds: Set<string>;
  /** The date of every sale the file lists, read or not, wherever it reads: what the sell-orders coverage spans. */
  listedDates: string[];
  listedSellOrders: number;
  listedPayouts: number;
  unreadablePayoutRows: number;
}

/** A listed sell order's id as stated, when it has the id's form. */
function statedId(entry: unknown): string | null {
  const id = isRecord(entry) ? entry.id : undefined;
  const text = typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? String(id) : id;
  return typeof text === 'string' && SELL_ORDER_ID.test(text) ? text : null;
}

/**
 * A listed sell order's own date as it reads: its placement's New York date whenever `placedAt` reads as an instant,
 * else its stated `placedDateNY`. Never a UTC calendar date.
 */
function statedDate(entry: unknown): string | null {
  if (!isRecord(entry)) return null;
  const placed = typeof entry.placedAt === 'string' ? canonicalStamp(entry.placedAt) : null;
  if (placed !== null) return metalsNewYorkDate(placed);
  return isCaptureDate(entry.placedDateNY) ? entry.placedDateNY : null;
}

const sellKey = (id: string) => metalsNaturalKey('collectpure', 'sell', [id]);

/**
 * Reads `collectpure.json`, as the account's base capture or a snapshot's (`form`). An issue inside one sell order holds
 * that order (a status key outside the closed list: `status-unknown`; a repeated id: every order with it,
 * `duplicate-in-capture`; anything else: `unreadable`), and an issue inside one payouts row leaves that row out; any
 * other issue refuses the file.
 */
function readConsolidated(json: unknown, form: CollectPureCaptureForm): ConsolidatedRead {
  const first = readCollectPureCapture(json, form);
  // Each listed sale's own date, read from the file as stated, so a sale set aside below still counts in the window.
  const datesOf = (entries: readonly unknown[]) => entries.flatMap((entry) => {
    const date = statedDate(entry);
    return date === null ? [] : [date];
  });
  if (first.ok) {
    const { capture } = first;
    return {
      capture, unreadable: [], listedIds: new Set(capture.sellOrders.map((order) => order.idKeyMaterial)),
      listedDates: datesOf(capture.sellOrders), listedSellOrders: capture.sellOrders.length, listedPayouts: capture.payouts.length,
      unreadablePayoutRows: 0,
    };
  }
  const orderIssues = new Map<number, CaptureIssue[]>();
  const payoutRows = new Set<number>();
  for (const issue of first.issues) {
    const order = SELL_ORDER_PATH.exec(issue.path);
    const payout = PAYOUT_ROW_PATH.exec(issue.path);
    if (order) orderIssues.set(Number(order[1]), [...(orderIssues.get(Number(order[1])) ?? []), issue]);
    else if (payout) payoutRows.add(Number(payout[1]));
    else throw new MetalsConvertError(issue.path === '$.schema' ? 'schema-unsupported' : 'capture-unreadable', issue.path);
  }
  if (first.issues.length >= CAPTURE_MAX_ISSUES) throw new MetalsConvertError('capture-unreadable', '$');
  const root = json as Record<string, unknown>;
  const entries = Array.isArray(root.sellOrders) ? root.sellOrders : [];
  const rows = Array.isArray(root.payouts) ? root.payouts : [];
  const ids = entries.map(statedId);
  const repeated = new Set<string>();
  for (const [index, issues] of orderIssues) {
    if (issues.some((issue) => issue.path === `$.sellOrders[${index}].id` && issue.message === REPEATED_ID) && ids[index] !== null) {
      repeated.add(ids[index]!);
    }
  }
  const unreadable: MetalsHeldRecord[] = [];
  const left = new Set<number>();
  for (const id of repeated) {
    const indices = ids.flatMap((other, index) => (other === id ? [index] : []));
    indices.forEach((index) => left.add(index));
    const dates = new Set(indices.map((index) => statedDate(entries[index])));
    const date = dates.size === 1 ? [...dates][0] : null;
    unreadable.push({ key: sellKey(id), channel: 'online', date, reason: 'duplicate-in-capture', check: 'sell-order-id' });
  }
  for (const [index, issues] of orderIssues) {
    if (left.has(index)) continue;
    left.add(index);
    const at = `$.sellOrders[${index}]`;
    const statusUnknown = issues.every((issue) => issue.path === `${at}.status.key` && issue.message === NOT_ALLOWED);
    const statusMissing = issues.every((issue) => (issue.path === `${at}.status` || issue.path === `${at}.status.key`) && issue.message === MISSING);
    const id = ids[index];
    unreadable.push({
      key: id === null ? null : sellKey(id),
      channel: 'online',
      date: statedDate(entries[index]),
      reason: statusUnknown ? 'status-unknown' : statusMissing ? 'field-missing' : 'unreadable',
      check: statusUnknown ? 'status-key' : statusMissing ? 'status' : 'sell-order-shape',
    });
  }
  const filtered = {
    ...root,
    sellOrders: entries.filter((_, index) => !left.has(index)),
    payouts: rows.filter((_, index) => !payoutRows.has(index)),
  };
  const second = readCollectPureCapture(filtered, form);
  if (!second.ok) throw new MetalsConvertError('capture-unreadable', second.issues[0]?.path);
  return {
    capture: second.capture,
    unreadable,
    listedIds: new Set(ids.filter((id): id is string => id !== null)),
    listedDates: datesOf(entries),
    listedSellOrders: entries.length,
    listedPayouts: rows.length,
    unreadablePayoutRows: payoutRows.size,
  };
}

// ---------------------------------------------------------------------------
// Raw sell orders, payout-history pages and stats
// ---------------------------------------------------------------------------

type RawSellOrder = { kind: 'read'; sellOrder: CollectPureSellOrder; stated: CollectPureRawStated } | { kind: 'unparseable' } | { kind: 'unreadable' };

function readRawSellOrders(files: ReadonlyMap<string, MetalsCaptureFile>): Map<string, RawSellOrder> {
  const out = new Map<string, RawSellOrder>();
  for (const [id, file] of files) {
    const parsed = parseJson(file.bytes);
    if (!parsed.ok) out.set(id, { kind: 'unparseable' });
    else {
      const read = readCollectPureRawSellOrder(parsed.json, id);
      out.set(id, read.ok ? { kind: 'read', sellOrder: read.sellOrder, stated: read.stated } : { kind: 'unreadable' });
    }
  }
  return out;
}

interface PayoutHistory {
  pages: number;
  items: CollectPurePayoutHistoryItem[];
  /** The rows read to the pager's end, or why that count is unknown. */
  pagerRows: { rows: number } | { gap: CollectPureCoverageGap };
}

/**
 * Reads the payout-history pages. A page that can't be read refuses the folder. The pager's rows count only when the
 * pages run p01…pNN with none missing, every page but the last names a next page, the last names none, and no payout id
 * repeats.
 */
function readPayoutHistory(files: ReadonlyMap<number, MetalsCaptureFile>): PayoutHistory {
  const numbers = [...files.keys()].sort((a, b) => a - b);
  const pages = numbers.map((number) => {
    const parsed = parseJson(files.get(number)!.bytes);
    const read = parsed.ok ? readCollectPurePayoutHistoryPage(parsed.json) : null;
    if (read === null || !read.ok) throw new MetalsConvertError('payout-history-unreadable', read === null ? '$' : read.issues[0]?.path);
    return read.page;
  });
  const items = pages.flatMap((page) => page.items);
  let pagerRows: PayoutHistory['pagerRows'] = { rows: items.length };
  if (pages.length === 0) pagerRows = { gap: 'payout-pages-missing' };
  else if (numbers.some((number, index) => number !== index + 1) || pages.some((page, index) => page.hasNext !== (index < pages.length - 1))) {
    pagerRows = { gap: 'pager-incomplete' };
  } else if (new Set(items.map((item) => item.payoutKeyMaterial)).size !== items.length) pagerRows = { gap: 'payout-ids-repeat' };
  return { pages: pages.length, items, pagerRows };
}

interface Stats {
  sell: CollectPureStatsCounts | null;
  buy: CollectPureStatsCounts | null;
  inventory: { totalCount: number; listedCount: number; unlistedCount: number } | null;
}

/**
 * Reads the stats files that are there. One that can't be read refuses the folder, and so does one that holds JSON
 * `null`: that file is there, so it is never taken for a missing one.
 */
function readStats(files: ReadonlyMap<'sell' | 'buy' | 'inventory', MetalsCaptureFile>): Stats {
  /** The file's JSON, or undefined when the file isn't there. */
  const parsed = (kind: 'sell' | 'buy' | 'inventory'): { json: unknown } | undefined => {
    const file = files.get(kind);
    if (file === undefined) return undefined;
    const json = parseJson(file.bytes);
    if (!json.ok) throw new MetalsConvertError('stats-unreadable', '$');
    return { json: json.json };
  };
  const order = (kind: 'sell' | 'buy') => {
    const file = parsed(kind);
    if (file === undefined) return null;
    const read = readCollectPureOrderStats(file.json);
    if (!read.ok) throw new MetalsConvertError('stats-unreadable', read.issues[0]?.path);
    return read.counts;
  };
  const inventoryFile = parsed('inventory');
  let inventory: Stats['inventory'] = null;
  if (inventoryFile !== undefined) {
    const read = readCollectPureInventoryStats(inventoryFile.json);
    if (!read.ok) throw new MetalsConvertError('stats-unreadable', read.issues[0]?.path);
    inventory = read.counts;
  }
  return { sell: order('sell'), buy: order('buy'), inventory };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

const pagesAt = (capture: CollectPureCapture, path: string) => capture.provenance.pages.filter((page) => page.path === path);

/** The window a coverage spans: its earliest date (or the capture day, with none) to the capture day. */
function windowOf(dates: readonly string[], capturedDay: string): { from: string; to: string } {
  const sorted = [...dates].sort();
  const from = sorted.length === 0 || sorted[0] > capturedDay ? capturedDay : sorted[0];
  const to = sorted.length === 0 || sorted[sorted.length - 1] < capturedDay ? capturedDay : sorted[sorted.length - 1];
  return { from, to };
}

function coverageOf(
  kind: 'sell-orders' | 'payouts',
  stated: { rows: number } | { gap: CollectPureCoverageGap },
  seen: number,
  window: { from: string; to: string },
): CollectPureCoverageReport {
  const count = 'rows' in stated ? stated.rows : null;
  return {
    kind, from: window.from, to: window.to, stated: count, seen, complete: count !== null && count === seen,
    statedBasis: COLLECTPURE_COVERAGE_BASES[kind], statedUnknownBecause: 'gap' in stated ? stated.gap : null,
  };
}

/**
 * Sell orders: the site's stated total. The sell-orders page's stats total, its list total and the raw sell stats'
 * total must all be stated and equal; otherwise the stated count is unknown.
 */
function sellOrdersStated(capture: CollectPureCapture, stats: Stats): { rows: number } | { gap: CollectPureCoverageGap } {
  const pages = pagesAt(capture, '/dashboard/sell-orders');
  if (pages.length !== 1) return { gap: 'sell-orders-page-missing' };
  if (stats.sell === null) return { gap: 'sell-stats-missing' };
  const [page] = pages;
  const total = page.statsCounts?.total ?? null;
  return total !== null && total === page.statedTotal && total === stats.sell.total ? { rows: total } : { gap: 'stated-totals-disagree' };
}

/**
 * Payouts: rows read to the pager's end (the site states no total). When the payouts page states how many pages and
 * rows the pull read, or a total, each must match the raw pages; a stated total only ever cross-checks the rows read.
 */
function payoutsStated(capture: CollectPureCapture, history: PayoutHistory): { rows: number } | { gap: CollectPureCoverageGap } {
  if ('gap' in history.pagerRows) return history.pagerRows;
  const pages = pagesAt(capture, '/dashboard/payouts');
  if (pages.length > 1) return { gap: 'pager-provenance-disagrees' };
  const [page] = pages;
  const rows = history.items.length;
  if (page !== undefined && ((page.pages !== null && page.pages !== history.pages) || (page.rowsSeen !== null && page.rowsSeen !== rows)
    || (page.statedTotal !== null && page.statedTotal !== rows))) {
    return { gap: 'pager-provenance-disagrees' };
  }
  return history.pagerRows;
}

// ---------------------------------------------------------------------------
// One sale
// ---------------------------------------------------------------------------

/** CollectPure's seven steps (and cancelled) on the ledger's sale lifecycle (design §4.3). */
const SELL_STATUS: Readonly<Record<CollectPureStatusKey, MetalsSellStatus>> = {
  pending_confirmation: 'agreed',
  ready_for_shipment: 'agreed',
  in_transit: 'shipped',
  items_received: 'received',
  check_in_progress: 'received',
  check_in_complete: 'inspected',
  order_complete: 'complete',
  cancelled: 'cancelled',
};

/** The steps after the first that are lifecycle events; the first step, the placement, is the agreement. */
const STEP_EVENTS: Partial<Record<CollectPureTimelineStatus, MetalsEventKind>> = {
  in_transit: 'shipped',
  items_received: 'received',
  check_in_complete: 'inspected',
  order_complete: 'completed',
};

/** Statuses at which the check-in is done, so an inspection not passed has failed. */
const INSPECTED: ReadonlySet<CollectPureStatusKey> = new Set(['check_in_complete', 'order_complete']);
const stepIndex = (status: CollectPureStatusKey) => (COLLECTPURE_TIMELINE_STATUSES as readonly string[]).indexOf(status);

const ORDER_METHOD = 'ach';
const TRANSACTION_METHOD = 'ACH';
const COMPLETE_PAYOUT = 'complete';

function canonical(value: unknown): string {
  const sorted = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sorted);
    if (isRecord(entry)) return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, sorted(entry[key])]));
    return entry;
  };
  return JSON.stringify(sorted(value));
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

interface Context {
  raw: ReadonlyMap<string, RawSellOrder>;
  listedById: ReadonlyMap<string, CollectPurePayout[]>;
  listedByOrder: ReadonlyMap<string, CollectPurePayout[]>;
  historyById: ReadonlyMap<string, CollectPurePayoutHistoryItem[]>;
  historyByOrder: ReadonlyMap<string, CollectPurePayoutHistoryItem[]>;
  /** Payout ids on more than one transaction in the capture. */
  sharedPayoutIds: ReadonlySet<string>;
  header: Omit<MetalsImportPayload, 'coverage' | 'orders' | 'competitors' | 'held'>;
  contractIssues: Array<{ path: string; message: string }>;
  /** Sales by their optional fees, as checkOptionalFees takes them: none, or the platform fee restated. */
  optionalFees: { none: number; restatedPlatformFee: number };
}

interface LineTally {
  dispositions: number;
  nonMetal: number;
  byMetal: Map<string, number>;
  byPack: Map<MetalPack, number>;
  byContent: Map<string, number>;
  stored: { title: number; productRef: number; program: number; premium: number };
  withheld: { title: number; productRef: number; program: number; premium: number };
  /** Product refs by the kind of line: stored, or withheld and why. */
  productRefs: Record<'metal' | 'flagged', { stored: number; withheld: Map<CollectPureProductRefWithheld, number> }>;
  /** Titles withheld, by why. */
  titlesWithheld: Map<CollectPureTitleWithheld, number>;
  /** Metal guard v1's flags on kept lines, and the sales that carry one (and also a metal line). */
  flagged: number;
  byClause: Map<RetailMetalGuardClause, number>;
  byFirstEvidence: Map<RetailMetalGuardEvidence, number>;
  byEvidence: Map<RetailMetalGuardEvidence, number>;
  adjacencyOnly: number;
  flaggedOrders: number;
  mixedOrders: number;
}

const emptyTally = (): LineTally => ({
  dispositions: 0, nonMetal: 0, byMetal: new Map(), byPack: new Map(), byContent: new Map(),
  stored: { title: 0, productRef: 0, program: 0, premium: 0 },
  withheld: { title: 0, productRef: 0, program: 0, premium: 0 },
  productRefs: { metal: { stored: 0, withheld: new Map() }, flagged: { stored: 0, withheld: new Map() } },
  titlesWithheld: new Map(),
  flagged: 0, byClause: new Map(), byFirstEvidence: new Map(), byEvidence: new Map(), adjacencyOnly: 0, flaggedOrders: 0, mixedOrders: 0,
});

const bump = <K>(counts: Map<K, number>, key: K) => counts.set(key, (counts.get(key) ?? 0) + 1);

/** A sale line's metal reading on its raw product name: the title rule's metal, the guard's flag, or neither. */
type LineReading =
  | { kind: 'metal'; evidence: RetailMetalEvidence }
  | { kind: 'flagged'; flag: MetalsLineMetalUncertain; clause: RetailMetalGuardClause }
  | { kind: 'none' };

/**
 * A sale line's metal reading, on its raw product name before any sanitizing or cut, as retail policy 5's Costco
 * converter reads a line: the title rule first (a metal line); then metal guard v1 on the same raw text (a flagged line:
 * the rule refused it, and it names a metal as a whole word and shows bullion evidence); else none. Every sale line is a
 * product sold back, so the rule reads (`assessed`) every line with a name, and a line without one is none.
 */
function lineReading(name: string | null): LineReading {
  if (name === null) return { kind: 'none' };
  const evidence = retailMetalTitleEvidence(name);
  if (evidence !== null) return { kind: 'metal', evidence };
  const reading = retailMetalTitleGuard(name, { assessed: true });
  if (reading.uncertain && reading.clause !== null) {
    return { kind: 'flagged', flag: { guard: RETAIL_METAL_GUARD, evidence: reading.evidence, metal: reading.metal }, clause: reading.clause };
  }
  return { kind: 'none' };
}

/**
 * The raw detail must be there, readable, and state what the consolidated file states: the same typed record, and,
 * where the raw file states them, its own id and its status's words. Those words (`order.status`, "Order Complete") are
 * what the consolidated record keeps as `status.detailStatus`, so they are compared with that, exactly, never with the
 * status key.
 */
function checkRawDetail(order: CollectPureSellOrder, context: Context): void {
  const raw = context.raw.get(order.idKeyMaterial);
  if (raw === undefined) hold('raw-missing', 'raw-sell-order');
  if (raw.kind === 'unparseable') hold('unreadable', 'raw-json');
  if (raw.kind === 'unreadable') hold('unreadable', 'raw-shape');
  const { idKeyMaterial, status } = raw.stated;
  if ((idKeyMaterial !== null && idKeyMaterial !== order.idKeyMaterial) || (status !== null && status !== order.status?.detailStatus)
    || canonical(collectPureRawComparable(order)) !== canonical(collectPureRawComparable(raw.sellOrder))) {
    hold('capture-disagreement', 'raw-detail');
  }
}

/**
 * The timeline, as every real capture shows it: it opens with the placement (`pending_confirmation`, "Order Placed"),
 * its steps run in the seven-step order each at most once, and its dated steps' instants strictly rise. A complete sale
 * has reached all seven steps. No step past the status has happened; a cancelled sale may have reached any step but
 * the last.
 */
function checkTimeline(order: CollectPureSellOrder, status: CollectPureStatusKey): void {
  const steps = order.timeline;
  const first = steps[0];
  if (first === undefined || first.at === null) hold('field-missing', 'first-step');
  if (first.status !== 'pending_confirmation') hold('status-ambiguous', 'timeline-order');
  let previousStep = -1;
  let previousAt = '';
  for (const step of steps) {
    if (stepIndex(step.status) <= previousStep) hold('status-ambiguous', 'timeline-order');
    previousStep = stepIndex(step.status);
    if (step.at === null) continue;
    // Canonical UTC instants, all of one width, sort as text.
    if (step.at <= previousAt) hold('status-ambiguous', 'timeline-order');
    previousAt = step.at;
  }
  if (status === 'order_complete' && (steps.length !== COLLECTPURE_TIMELINE_STATUSES.length || steps.some((step) => step.at === null))) {
    hold('status-ambiguous', 'timeline-incomplete');
  }
  const last = status === 'cancelled' ? stepIndex('check_in_complete') : stepIndex(status);
  if (steps.some((step) => step.at !== null && stepIndex(step.status) > last)) hold('status-ambiguous', 'timeline-ahead');
}

/** The trade moment (`placedAt`, the first step's instant) and the agreed day (its New York date, as the capture says). */
function tradeMomentOf(order: CollectPureSellOrder): { placedAt: string; agreedDay: string } {
  const placedAt = order.placedAt ?? hold('field-missing', 'placed-at');
  if (order.timeline[0].at !== placedAt) hold('capture-disagreement', 'trade-moment');
  const agreedDay = metalsNewYorkDate(placedAt);
  const stated = order.placedDateNY ?? hold('field-missing', 'placed-date-ny');
  if (stated !== agreedDay) hold('capture-disagreement', 'agreed-day');
  for (const step of order.timeline) {
    if (step.at === null) continue;
    const day = metalsNewYorkDate(step.at);
    if (step.dateNY !== null && step.dateNY !== day) hold('capture-disagreement', 'step-date');
  }
  if (order.priceLockStatedOnPage === true) hold('field-unsupported', 'price-lock');
  return { placedAt, agreedDay };
}

/** The sale's status, once its timeline is checked against it. */
function statusOf(order: CollectPureSellOrder): CollectPureStatusKey {
  const status = order.status?.key ?? hold('field-missing', 'status');
  checkTimeline(order, status);
  return status;
}

/** The page breakdown's row for the platform fee: "Platform Fee", with its rate in parentheses when the page states one. */
const PLATFORM_FEE_ROW = /^Platform Fee(?: \([^()]{1,40}\))?$/;

/**
 * Whether the sale's optional fees are its platform fee restated (ROOT's ruling): exactly one optional fee, negative,
 * equal to the cent to the stated platform fee and to the page breakdown's one Platform Fee row, with the payout
 * identity holding with the fee counted once. Real captures state it so on every sale, under a title of its own.
 */
function restatesPlatformFee(order: CollectPureSellOrder): boolean {
  const { optionalFees, processingFeeMinor, subtotalMinor, shippingMinor, totalMinor } = order.amounts;
  if (optionalFees.length !== 1 || processingFeeMinor === null) return false;
  const [{ feeMinor }] = optionalFees;
  const rows = order.pageBreakdown.filter((row) => PLATFORM_FEE_ROW.test(row.label));
  return feeMinor < 0 && feeMinor === processingFeeMinor && rows.length === 1 && rows[0].amountMinor === feeMinor
    && subtotalMinor + (shippingMinor ?? 0) + processingFeeMinor === totalMinor;
}

/**
 * A sale's optional fees: none, or its platform fee restated, which is then never a component of its own, never counted
 * and never stored. The report counts the sales of each, so any drift shows; any other optional fee holds the sale.
 */
function checkOptionalFees(order: CollectPureSellOrder, context: Context): void {
  if (order.amounts.optionalFees.length === 0) {
    context.optionalFees.none += 1;
    return;
  }
  if (!restatesPlatformFee(order)) hold('field-unsupported', 'optional-fee');
  context.optionalFees.restatedPlatformFee += 1;
}

/** The money facts no reviewed rule covers, and the line identity: quantity × unit price = line total, Σ = subtotal. */
function checkMoney(order: CollectPureSellOrder, status: CollectPureStatusKey): void {
  const { amounts } = order;
  if (amounts.appliedPromotions > 0) hold('field-unsupported', 'promotion');
  if (amounts.salesTaxMinor !== null && amounts.salesTaxMinor !== 0) hold('field-unsupported', 'sales-tax');
  if (amounts.instantPayoutAdvance !== null) hold('field-unsupported', 'instant-payout-advance');
  if ((order.combinedSellOrderKeyMaterial ?? []).length > 0) hold('field-unsupported', 'combined-sell-order');
  // Both deductions are stated signed, as the page shows them: zero or negative. One stated positive would add money.
  if ((amounts.shippingMinor ?? 0) > 0 || (amounts.processingFeeMinor ?? 0) > 0) hold('field-unsupported', 'positive-deduction');
  if (order.lines.length === 0) hold('field-missing', 'lines');
  if (new Set(order.lines.map((line) => line.lineItemId)).size !== order.lines.length) hold('duplicate-in-capture', 'line-id');
  for (const line of order.lines) {
    if (line.qty < 1) hold('quantity-unknown', 'line-quantity');
    if (line.unitPriceMinor < 0) hold('field-unsupported', 'negative-price');
    if (line.lineTotalMinor === null || line.qty * line.unitPriceMinor !== line.lineTotalMinor) hold('identity-failed', 'line-total');
  }
  if (sum(order.lines.map((line) => line.lineTotalMinor ?? 0)) !== amounts.subtotalMinor) hold('identity-failed', 'subtotal');
  if (status === 'order_complete' && order.lines.some((line) => line.status === 'Item Pending')) hold('status-ambiguous', 'line-pending');
}

/** A line's inspection: passed, failed (not passed once the check-in is done), pending, or not tracked (null). */
function inspectionOf(line: CollectPureLine, checkedIn: boolean): MetalsInspection | null {
  const stated = line.inspection;
  if (stated === null) return null;
  for (const value of [stated.receivedForInspection, stated.passedInspection, stated.buyerPaid]) {
    if (value !== null && typeof value !== 'boolean') hold('field-unsupported', 'inspection-value');
  }
  if (stated.passedInspection === true) return 'passed';
  return stated.passedInspection === false && checkedIn ? 'failed' : 'pending';
}

/** Whether the sale's check-in is done: its status says so, or its timeline has reached that step (a cancelled sale). */
const checkedIn = (order: CollectPureSellOrder, status: CollectPureStatusKey) => INSPECTED.has(status)
  || order.timeline.some((step) => step.at !== null && stepIndex(step.status) >= stepIndex('check_in_complete'));

const sameListed = (row: CollectPurePayout, id: string, transaction: CollectPurePayoutTransaction) =>
  row.sellOrderKeyMaterial === id && row.amountMinor === transaction.amountMinor && row.method === transaction.method
  && row.status === transaction.status && row.payoutDate === transaction.payoutDate && row.payoutDateRaw === transaction.payoutDateRaw
  && row.initiatedAt === transaction.initiatedAt;

const sameHistory = (item: CollectPurePayoutHistoryItem, id: string, transaction: CollectPurePayoutTransaction) =>
  item.sellOrderKeyMaterial === id && item.amountMinor === transaction.amountMinor && item.method === transaction.method
  && item.status === transaction.status && item.payoutDate === transaction.payoutDate && item.payoutDate === transaction.payoutDateRaw
  && item.createdAt === transaction.initiatedAt;

/**
 * The sale's payouts: ACH and complete only, each dated (its creation and payout date), agreeing with the consolidated
 * payouts list and the raw payout-history pages, nothing else listed for the sale, and the total paid their sum. No
 * payout is created or paid before the agreed day, nor paid before it was created.
 */
function payoutsOf(order: CollectPureSellOrder, agreedDay: string, context: Context): MetalsPayout[] {
  const id = order.idKeyMaterial;
  const { method, destinationLast4, transactions, totalPaidMinor } = order.payout;
  if ((method !== null || transactions.length > 0) && method !== ORDER_METHOD) hold('payout-unsupported', 'payout-method');
  for (const transaction of transactions) {
    if (transaction.method !== TRANSACTION_METHOD) hold('payout-unsupported', 'payout-method');
    if (transaction.status !== COMPLETE_PAYOUT) hold('payout-unsupported', 'payout-status');
    if (transaction.amountMinor < 1) hold('payout-unsupported', 'payout-amount');
    if (transaction.payoutDate === null || transaction.payoutDateRaw === null || transaction.initiatedAt === null) hold('field-missing', 'payout-date');
    if (context.sharedPayoutIds.has(transaction.payoutKeyMaterial)) hold('duplicate-in-capture', 'payout-id');
  }
  if ((context.listedByOrder.get(id) ?? []).length !== transactions.length) hold('capture-disagreement', 'payout-list');
  for (const transaction of transactions) {
    const rows = context.listedById.get(transaction.payoutKeyMaterial) ?? [];
    if (rows.length !== 1 || !sameListed(rows[0], id, transaction)) hold('capture-disagreement', 'payout-list');
  }
  if ((context.historyByOrder.get(id) ?? []).length !== transactions.length) hold('capture-disagreement', 'payout-history');
  for (const transaction of transactions) {
    const items = context.historyById.get(transaction.payoutKeyMaterial) ?? [];
    if (items.length !== 1 || !sameHistory(items[0], id, transaction)) hold('capture-disagreement', 'payout-history');
  }
  if (totalPaidMinor !== sum(transactions.map((transaction) => transaction.amountMinor))) hold('capture-disagreement', 'total-paid');
  return transactions.map((transaction) => {
    const initiatedDate = metalsNewYorkDate(transaction.initiatedAt!);
    const payoutDate = transaction.payoutDate!;
    if (initiatedDate < agreedDay || payoutDate < initiatedDate) hold('capture-disagreement', 'payout-date-order');
    return {
      key: metalsNaturalKey('collectpure', 'payout', [transaction.payoutKeyMaterial]),
      method: 'ach',
      destinationLast4,
      amountMinor: transaction.amountMinor,
      initiatedDate,
      payoutDate,
      status: 'complete',
    };
  });
}

/** The payout identity: subtotal − insured shipping − platform fee = total payout; a complete sale is paid exactly that. */
function checkPayoutIdentity(order: CollectPureSellOrder, status: CollectPureStatusKey, payouts: readonly MetalsPayout[]): void {
  const { subtotalMinor, shippingMinor, processingFeeMinor, totalMinor } = order.amounts;
  // subtotal − insured shipping − platform fee = total payout, with both deductions as stated: zero or negative.
  if (subtotalMinor + (shippingMinor ?? 0) + (processingFeeMinor ?? 0) !== totalMinor) hold('identity-failed', 'payout-identity');
  const paid = sum(payouts.map((payout) => payout.amountMinor));
  if (status === 'cancelled' && payouts.length > 0) hold('status-ambiguous', 'cancelled-with-payout');
  if (status === 'order_complete' ? paid !== totalMinor : paid > totalMinor) hold('identity-failed', 'paid-total');
}

/**
 * Each line's events: agreed on the agreed day, then each later step the sale has reached, dated by its instant's New
 * York date, or undated when the capture gives the step no time. A step past the status is no event, nor is a cancelled
 * sale's undated step (it can't be told reached). A cancellation is undated.
 */
function eventsOf(order: CollectPureSellOrder, quantity: number, agreedDay: string, status: CollectPureStatusKey): MetalsEvent[] {
  const events: Array<Omit<MetalsEvent, 'occurrence'>> = [{ kind: 'agreed', date: agreedDay, dateBasis: 'stated', quantity }];
  for (const step of order.timeline.slice(1)) {
    const kind = STEP_EVENTS[step.status];
    if (kind === undefined) continue;
    if (step.at !== null) events.push({ kind, date: metalsNewYorkDate(step.at), dateBasis: 'stated', quantity });
    else if (status !== 'cancelled' && stepIndex(step.status) <= stepIndex(status)) events.push({ kind, date: null, dateBasis: null, quantity });
  }
  if (status === 'cancelled') events.push({ kind: 'cancelled', date: null, dateBasis: null, quantity });
  const seen = new Map<string, number>();
  return events.map((event) => {
    const identity = `${event.kind}\u0000${event.date ?? ''}\u0000${event.quantity}`;
    const occurrence = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, occurrence);
    return { ...event, occurrence };
  });
}

/** One consolidated sell order as a sale, or a Hold. */
function convertSale(order: CollectPureSellOrder, context: Context): { sale: MetalsOrder; tally: LineTally } {
  checkRawDetail(order, context);
  const status = statusOf(order);
  const { placedAt, agreedDay } = tradeMomentOf(order);
  checkOptionalFees(order, context);
  checkMoney(order, status);
  const done = checkedIn(order, status);
  const inspections = order.lines.map((line) => inspectionOf(line, done));
  if (inspections.includes('failed')) hold('inspection-failed', 'inspection');
  const payouts = payoutsOf(order, agreedDay, context);
  checkPayoutIdentity(order, status, payouts);
  const readings = order.lines.map((line) => lineReading(line.name));
  // Holds first: every check above holds the sale whatever its lines read. Then a sale with no line the rule names a
  // metal and none the guard flags holds; a flagged line alone carries its sale, in full (fail-closed: never dropped).
  if (readings.every((reading) => reading.kind === 'none')) hold('field-unsupported', 'no-metal-line');

  const skeleton: MetalsSkeletonLine[] = order.lines.map((line, ordinal) => ({
    ordinal, kind: 'item', amountMinor: line.lineTotalMinor!, shippingMinor: null, feeParent: null, couponTarget: null, taxFlag: null,
    // A flagged line is a metal line of the skeleton (provisionally bullion), so the deductions reach it as metal.
    metal: readings[ordinal].kind !== 'none',
  }));
  const components: MetalsOrderComponent[] = [];
  // The two deductions as stated (zero or negative): the components' own sign.
  if (order.amounts.processingFeeMinor !== null) components.push({ kind: 'platform-fee', amountMinor: order.amounts.processingFeeMinor });
  if (order.amounts.shippingMinor !== null) components.push({ kind: 'insured-shipping', amountMinor: order.amounts.shippingMinor });
  const allocation = metalsAllocation(skeleton, components);
  const tally = emptyTally();
  const lines: MetalsLine[] = [];
  order.lines.forEach((line, ordinal) => {
    const reading = readings[ordinal];
    if (reading.kind === 'none') {
      tally.nonMetal += 1;
      return;
    }
    const found = reading.kind === 'metal' ? reading.evidence : null;
    const flag = reading.kind === 'flagged' ? reading.flag : null;
    const money = allocation.lines.find((entry) => entry.ordinal === ordinal)!;
    // Pack, purity, mass basis and design are read on the raw product name, before any sanitizing or cut.
    const pack = retailMetalPack(line.name);
    const observed = metalsTitleObservations(line.name);
    // A flagged line has no metal, form or stated mass of its own (the rule refused its name): its flag holds it
    // `bullion-unconfirmed` until the owner decides.
    const content: MetalsContentEvidence = {
      source: 'collectpure', metal: found?.metal ?? null, form: found?.form ?? null,
      statedMass: found?.statedWeight ? { value: found.statedWeight.value, unit: found.statedWeight.unit } : null,
      pack, purity: observed.purity, massBasis: observed.massBasis, design: observed.design, metalUncertain: flag,
    };
    const fine = metalsFineContentWire(metalsFineContent(content));
    const title = storedTitle(line.name, pack, flag !== null);
    const productRef = productRefOf(line.sku);
    const program = shortText(line.program);
    const premium = premiumOf(line);
    tally.dispositions += 1;
    if (reading.kind === 'metal') bump(tally.byMetal, reading.evidence.metal ?? 'none');
    else {
      tally.flagged += 1;
      bump(tally.byClause, reading.clause);
      bump(tally.byFirstEvidence, reading.flag.evidence[0]);
      for (const code of reading.flag.evidence) bump(tally.byEvidence, code);
      if (reading.flag.evidence.every((code) => code === 'adjacency')) tally.adjacencyOnly += 1;
    }
    bump(tally.byPack, pack);
    bump(tally.byContent, 'basis' in fine ? fine.basis : fine.hold);
    if (title.text !== null) tally.stored.title += 1;
    if (productRef.ref !== null) tally.stored.productRef += 1;
    if (program.text !== null) tally.stored.program += 1;
    if (premium.premium !== null) tally.stored.premium += 1;
    if (title.withheld !== null) {
      tally.withheld.title += 1;
      bump(tally.titlesWithheld, title.withheld);
    }
    const refs = tally.productRefs[reading.kind];
    if (productRef.withheld === null) refs.stored += 1;
    else {
      bump(refs.withheld, productRef.withheld);
      // A line that states no SKU counts in neither the stored nor the withheld texts.
      if (productRef.withheld !== 'absent') tally.withheld.productRef += 1;
    }
    if (program.withheld) tally.withheld.program += 1;
    if (premium.withheld) tally.withheld.premium += 1;
    lines.push({
      key: metalsNaturalKey('collectpure', 'sline', [order.idKeyMaterial, line.lineItemId]),
      ordinal,
      title: title.text,
      productRef: productRef.ref,
      metal: content.metal,
      // The guard's flag, or null. Null is no flag: the title rule read the raw name as metal, so the line's reading
      // never asked the guard (a line neither reads is no disposition). METALS_RULES.titleGuard names it from 1E on.
      metalUncertain: flag,
      form: content.form,
      statedMass: content.statedMass,
      pack,
      purity: content.purity,
      massBasis: content.massBasis,
      design: content.design,
      contentFingerprint: metalsContentFingerprint(content),
      fine,
      quantity: line.qty,
      unitPriceMinor: line.unitPriceMinor,
      amountMinor: line.lineTotalMinor!,
      directMinor: money.directMinor,
      allocated: money.allocated,
      costMinor: null,
      netMinor: money.totalMinor,
      complete: money.complete,
      events: eventsOf(order, line.qty, agreedDay, status),
      seller: null,
      sale: { program: program.text, premium: premium.premium, inspection: inspections[ordinal] },
    });
  });
  if (tally.flagged > 0) {
    tally.flaggedOrders = 1;
    if (tally.flagged < tally.dispositions) tally.mixedOrders = 1;
  }
  const completeStep = status === 'order_complete' ? order.timeline.find((step) => step.status === 'order_complete' && step.at !== null) : undefined;
  const sale: MetalsOrder = {
    key: sellKey(order.idKeyMaterial),
    side: 'sell',
    channel: 'online',
    date: agreedDay,
    tradeMoment: placedAt,
    completedDate: completeStep?.at ? metalsNewYorkDate(completeStep.at) : null,
    currency: 'USD',
    status: SELL_STATUS[status],
    skeleton,
    components,
    admission: null,
    evidence: [],
    refunds: [],
    payouts,
    unattributedMinor: allocation.unattributedMinor,
    fullPriceMinor: allocation.fullPriceMinor,
    lines,
  };
  // A last guard: a sale the payload's validator refuses (a quantity or weight outside its grammar, say) is held, and
  // the validator's structural path and fixed message go to the report.
  const alone = validateMetalsImportPayload({ ...context.header, coverage: [], orders: [sale], competitors: [], held: [] });
  if (!alone.ok) {
    context.contractIssues.push({ path: alone.issues[0].path, message: alone.issues[0].message });
    hold('field-unsupported', 'payload-contract');
  }
  return { sale, tally };
}

/** Adds one sale's tally into the folder's. */
function addTally(into: LineTally, add: LineTally): void {
  for (const name of ['dispositions', 'nonMetal', 'flagged', 'adjacencyOnly', 'flaggedOrders', 'mixedOrders'] as const) into[name] += add[name];
  const merge = <K>(counts: Map<K, number>, more: ReadonlyMap<K, number>) => {
    for (const [key, count] of more) counts.set(key, (counts.get(key) ?? 0) + count);
  };
  merge(into.byMetal, add.byMetal);
  merge(into.byPack, add.byPack);
  merge(into.byContent, add.byContent);
  merge(into.byClause, add.byClause);
  merge(into.byFirstEvidence, add.byFirstEvidence);
  merge(into.byEvidence, add.byEvidence);
  for (const kind of ['metal', 'flagged'] as const) {
    into.productRefs[kind].stored += add.productRefs[kind].stored;
    merge(into.productRefs[kind].withheld, add.productRefs[kind].withheld);
  }
  merge(into.titlesWithheld, add.titlesWithheld);
  for (const name of ['title', 'productRef', 'program', 'premium'] as const) {
    into.stored[name] += add.stored[name];
    into.withheld[name] += add.withheld[name];
  }
}

// ---------------------------------------------------------------------------
// The guard census
// ---------------------------------------------------------------------------

/** Where a captured line is expected (from its raw reading) or found (by its representation in the payload). */
type CensusPosition = 'held' | 'metal' | 'flagged' | 'drift' | 'elsewhere';

/** The account holds' reasons: keyless records of buy orders, inventory rows and the vault, never of a sale. */
const ACCOUNT_HOLD_REASONS: ReadonlySet<string> = new Set(['buy-side-unsupported', 'vault-unsupported']);

/** A line of one captured order as a raw file states it: its id (as the capture's reader takes one) and raw name. */
interface CensusLine {
  lineId: string | null;
  title: string | null;
}

/** A sell order's id as the capture states it, when it has an id's form (a whole number reads as its digits). */
function censusSellOrderId(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  return typeof text === 'string' && SELL_ORDER_ID.test(text) ? text : null;
}

/** An order's lines, from a raw list, by the given id and name fields: every entry in its place (its ordinal). */
function censusLines(list: unknown, idOf: (line: Record<string, unknown>) => unknown, titleOf: (line: Record<string, unknown>) => unknown): CensusLine[] {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    if (!isRecord(entry)) return { lineId: null, title: null };
    const id = idOf(entry);
    const title = titleOf(entry);
    return {
      lineId: typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? String(id) : typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : null,
      title: typeof title === 'string' && title.length > 0 ? title : null,
    };
  });
}

/**
 * A metal-word line's expected position: held, when its order is a held record ("holds first"); else the title rule's
 * metal FIRST, so that a gap in the guard would still be expected metal; else flagged, when the guard flags it; else
 * drift.
 */
function expectedPosition(held: boolean, title: string, guard: RetailMetalGuardReading): Exclude<CensusPosition, 'elsewhere'> {
  if (held) return 'held';
  if (retailMetalTitleEvidence(title) !== null) return 'metal';
  return guard.uncertain ? 'flagged' : 'drift';
}

/**
 * Where a line of an order outside the held records is, by representation (spec Amendment 2.1): a metal line (its
 * `metal` null only for a title naming several metals), a flagged line, an anonymous non-metal line of its sale's
 * skeleton (drift), or elsewhere.
 */
function actualPosition(order: MetalsOrder | undefined, id: string, line: CensusLine, ordinal: number): CensusPosition {
  // An order the payload doesn't keep has no line and no skeleton item, so each of its lines is elsewhere.
  const lines = order?.lines ?? [];
  const kept = line.lineId === null ? undefined : lines.find((entry) => entry.key === metalsNaturalKey('collectpure', 'sline', [id, line.lineId!]));
  if (kept !== undefined) return kept.ordinal !== ordinal ? 'elsewhere' : kept.metalUncertain !== null ? 'flagged' : 'metal';
  const item = order?.skeleton[ordinal];
  const anonymous = item !== undefined && item.kind === 'item' && !item.metal && !lines.some((entry) => entry.ordinal === ordinal);
  return anonymous ? 'drift' : 'elsewhere';
}

/**
 * The guard census (guard-integration spec: its census, and Amendment 2). Once the payload is built, the folder's raw
 * files are read again, with none of the converter's parsed objects. Every line of every captured order whose raw
 * product name holds a whole metal word (metal guard v1's `metalWord`) is counted once, by its expected position, and
 * checked against its position in the payload: a line whose positions differ is an omission. An order's lines and their
 * readings come from one raw source: the consolidated list where it names the order, else the order's raw file. The
 * capture states buy orders only as counts, and its layout reads no buy-order file, so the buy side holds no line: every
 * buy order is a keyless held record.
 */
function guardCensus(files: FolderFiles, payload: MetalsImportPayload): { census: CollectPureGuardCensus; heldAlsoFlaggedOrders: number } {
  const heldKeys = new Set(payload.held.flatMap((record) => (record.key === null ? [] : [record.key])));
  // A listed sell order with no readable id can only be a keyless held record.
  const keylessSaleHeld = payload.held.some((record) => record.key === null && !ACCOUNT_HOLD_REASONS.has(record.reason));
  const ordersByKey = new Map(payload.orders.map((order) => [order.key, order]));
  const census: CollectPureGuardCensus = { universe: 0, heldMetalWordLines: 0, metal: 0, flagged: 0, drift: 0, omissions: 0, omissionsByPlace: {} };
  let heldAlsoFlaggedOrders = 0;
  const count = (id: string | null, lines: readonly CensusLine[]) => {
    const key = id === null ? null : sellKey(id);
    const held = key === null ? keylessSaleHeld : heldKeys.has(key);
    const order = key === null ? undefined : ordersByKey.get(key);
    let wouldFlag = false;
    lines.forEach((line, ordinal) => {
      if (line.title === null) return;
      const guard = retailMetalTitleGuard(line.title, { assessed: true });
      if (!guard.metalWord) return;
      census.universe += 1;
      if (guard.uncertain) wouldFlag = true;
      const expected = expectedPosition(held, line.title, guard);
      const actual = held ? 'held' : id === null ? 'elsewhere' : actualPosition(order, id, line, ordinal);
      if (expected === 'held') census.heldMetalWordLines += 1;
      else census[expected] += 1;
      if (actual !== expected) {
        census.omissions += 1;
        const place = `${expected}>${actual}`;
        census.omissionsByPlace[place] = (census.omissionsByPlace[place] ?? 0) + 1;
      }
    });
    if (held && wouldFlag) heldAlsoFlaggedOrders += 1;
  };
  const consolidated = parseJson(files.consolidated.bytes);
  const root = consolidated.ok && isRecord(consolidated.json) ? consolidated.json : {};
  const listed = new Set<string>();
  for (const entry of Array.isArray(root.sellOrders) ? root.sellOrders : []) {
    const record = isRecord(entry) ? entry : {};
    const id = censusSellOrderId(record.id);
    if (id !== null) listed.add(id);
    count(id, censusLines(record.lines, (line) => line.lineItemId, (line) => line.name));
  }
  for (const [id, file] of files.rawSellOrders) {
    if (listed.has(id)) continue;
    const raw = parseJson(file.bytes);
    const order = raw.ok && isRecord(raw.json) && isRecord(raw.json.order) ? raw.json.order : {};
    count(id, censusLines(order.lineItems, (line) => line.id, (line) => (isRecord(line.product) ? line.product.title : undefined)));
  }
  census.omissionsByPlace = Object.fromEntries(Object.entries(census.omissionsByPlace).sort(([a], [b]) => byText(a, b)));
  return { census, heldAlsoFlaggedOrders };
}

/**
 * The guard census of a capture folder against a payload, as the converter's report states it for the payload it
 * converts (guardCensus): the folder's raw files read again, apart from the routing. Exported so that the census can be
 * shown to find what a payload doesn't show where its raw lines belong.
 */
export function collectPureGuardCensus(folder: MetalsCaptureFolder, payload: MetalsImportPayload): CollectPureGuardCensus {
  return guardCensus(folderFiles(folder.files), payload).census;
}

// ---------------------------------------------------------------------------
// The folder
// ---------------------------------------------------------------------------

const group = <T>(items: readonly T[], keyOf: (item: T) => string) => {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(keyOf(item), [...(out.get(keyOf(item)) ?? []), item]);
  return out;
};

const keyless = (reason: 'buy-side-unsupported' | 'vault-unsupported', check: string, count: number): MetalsHeldRecord[] =>
  Array.from({ length: count }, () => ({ key: null, channel: 'online', date: null, reason, check }));

/**
 * How many buy orders and inventory rows any statement shows, the largest; and the vault's holds. When there are more
 * than the payload's held records can hold (`room`), the folder is refused before any record is made.
 */
function accountHolds(capture: CollectPureCapture, stats: Stats, room: number): MetalsHeldRecord[] {
  const pageCount = (path: string) => Math.max(0, ...pagesAt(capture, path).flatMap((page) => [page.statedTotal ?? 0, page.rowsSeen ?? 0]));
  const { buyOrders, inventory, vault } = capture;
  const buys = Math.max(buyOrders.statedTotal, buyOrders.rows, buyOrders.statsCounts?.total ?? 0, stats.buy?.total ?? 0, pageCount('/dashboard/buy-orders'));
  const rows = Math.max(
    inventory.statedTotal ?? 0, inventory.rows ?? 0, inventory.totalCount ?? 0, (inventory.listedCount ?? 0) + (inventory.unlistedCount ?? 0),
    stats.inventory?.totalCount ?? 0, (stats.inventory?.listedCount ?? 0) + (stats.inventory?.unlistedCount ?? 0), pageCount('/dashboard/inventory'),
  );
  const vaultEnabled = vault.enabled ? 1 : 0;
  if (buys + rows + vaultEnabled + vault.holdingsCount > room) throw new MetalsConvertError('held-unrepresentable');
  return [
    ...keyless('buy-side-unsupported', 'buy-order', buys),
    ...keyless('buy-side-unsupported', 'inventory-row', rows),
    ...keyless('vault-unsupported', 'vault-enabled', vaultEnabled),
    ...keyless('vault-unsupported', 'vault-holding', vault.holdingsCount),
  ];
}

/** Ordinal text order, the same on every machine (never a locale's collation). */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The order of a payload's held records: by key (keyless last), then reason and check. */
const heldOrder = (a: MetalsHeldRecord, b: MetalsHeldRecord) =>
  (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0) || byText(a.key ?? '', b.key ?? '') || byText(a.reason, b.reason)
  || byText(a.check, b.check);

/** Converts one CollectPure capture folder (`collectpure@1`): its payload, canonical text and value-free report. */
export function convertCollectPureCapture(folder: MetalsCaptureFolder): MetalsConvertOutput<CollectPureConvertReport> {
  if (!COLLECTPURE_ACCOUNT_FOLDER.test(folder.folder)) throw new MetalsConvertError('folder-unsupported', 'folder');
  if (folder.snapshot !== null && !COLLECTPURE_SNAPSHOT_FOLDER.test(folder.snapshot)) throw new MetalsConvertError('folder-unsupported', 'snapshot');
  // The payload names the title rule's version: the rule this converter runs must be that one.
  if (RETAIL_METAL_TITLE_RULE !== METALS_RULES.title) throw new MetalsConvertError('title-rule-version');
  const files = folderFiles(folder.files);
  const parsed = parseJson(files.consolidated.bytes);
  if (!parsed.ok) throw new MetalsConvertError('capture-unreadable', '$');
  const consolidated = readConsolidated(parsed.json, folder.snapshot === null ? 'base' : 'snapshot');
  const { capture } = consolidated;
  const history = readPayoutHistory(files.payoutPages);
  const stats = readStats(files.stats);
  const raw = readRawSellOrders(files.rawSellOrders);
  const capturedDay = metalsNewYorkDate(capture.provenance.capturedAt);

  const transactions = capture.sellOrders.flatMap((order) => order.payout.transactions);
  const transactionsById = group(transactions, (transaction) => transaction.payoutKeyMaterial);
  const captureDigest = metalsDigest(files.consolidated.bytes);
  const { capturedAt } = capture.provenance;
  const header: Context['header'] = {
    format: METALS_IMPORT_FORMAT,
    version: METALS_IMPORT_VERSION,
    source: 'collectpure',
    account: { folder: folder.folder, identityLast4: null },
    converterVersion: folder.converterVersion,
    policyVersion: METALS_CONVERT_POLICY_VERSION,
    rules: { ...METALS_RULES },
    input: { schema: METALS_CAPTURE_SCHEMAS.collectpure, captureDigest, capturedAt, files: folder.files.length },
  };
  const context: Context = {
    raw,
    listedById: group(capture.payouts, (row) => row.payoutKeyMaterial),
    listedByOrder: group(capture.payouts, (row) => row.sellOrderKeyMaterial),
    historyById: group(history.items, (item) => item.payoutKeyMaterial),
    historyByOrder: group(history.items, (item) => item.sellOrderKeyMaterial),
    sharedPayoutIds: new Set([...transactionsById].filter(([, list]) => list.length > 1).map(([id]) => id)),
    header,
    contractIssues: [],
    optionalFees: { none: 0, restatedPlatformFee: 0 },
  };

  const orders: MetalsOrder[] = [];
  const held: MetalsHeldRecord[] = [...consolidated.unreadable];
  const tally = emptyTally();
  for (const order of capture.sellOrders) {
    try {
      const converted = convertSale(order, context);
      orders.push(converted.sale);
      addTally(tally, converted.tally);
    } catch (error) {
      if (!(error instanceof Hold)) throw error;
      // placedAt's New York date even when the hold disputes the stated one; the stated date only without placedAt.
      const date = order.placedAt !== null ? metalsNewYorkDate(order.placedAt) : order.placedDateNY;
      held.push({ key: sellKey(order.idKeyMaterial), channel: 'online', date, reason: error.reason, check: error.check });
    }
  }
  const salesHeld = held.length;

  // Raw sell orders the list doesn't name, then sell orders that only a payout names: held, never dropped.
  const unlisted = [...raw.keys()].filter((id) => !consolidated.listedIds.has(id)).sort();
  for (const id of unlisted) {
    const detail = raw.get(id)!;
    const first = detail.kind === 'read' ? detail.sellOrder.timeline[0]?.at ?? null : null;
    held.push({ key: sellKey(id), channel: 'online', date: first === null ? null : metalsNewYorkDate(first), reason: 'capture-disagreement', check: 'raw-without-listing' });
  }
  const known = new Set([...consolidated.listedIds, ...unlisted]);
  const paidOnly = new Set([...capture.payouts, ...history.items].map((payout) => payout.sellOrderKeyMaterial).filter((id) => !known.has(id)));
  for (const id of [...paidOnly].sort()) {
    held.push({ key: sellKey(id), channel: 'online', date: null, reason: 'capture-disagreement', check: 'payout-without-sell-order' });
  }
  held.push(...accountHolds(capture, stats, METALS_MAX_ORDERS - held.length));

  orders.sort((a, b) => byText(a.key, b.key));
  held.sort(heldOrder);
  const coverage = [
    coverageOf('sell-orders', sellOrdersStated(capture, stats), consolidated.listedSellOrders, windowOf(consolidated.listedDates, capturedDay)),
    coverageOf('payouts', payoutsStated(capture, history), consolidated.listedPayouts,
      windowOf(capture.payouts.flatMap((row) => (row.payoutDate === null ? [] : [row.payoutDate])), capturedDay)),
  ];
  const payload: MetalsImportPayload = {
    ...header,
    coverage: coverage.map(({ kind, from, to, stated, seen, complete }) => ({ kind, from, to, stated, seen, complete })),
    orders,
    competitors: [],
    held,
  };

  const byStatus = Object.fromEntries(METALS_SELL_STATUSES.map((status) => [status, 0])) as Record<MetalsSellStatus, number>;
  for (const order of orders) byStatus[order.status!] += 1;
  const agreed = orders.map((order) => order.date).sort();
  const heldCounts: Record<string, number> = {};
  for (const record of held) heldCounts[`${record.reason}/${record.check}`] = (heldCounts[`${record.reason}/${record.check}`] ?? 0) + 1;
  // After the payload is built: the census reads the raw files again, independently of the routing above.
  const { census, heldAlsoFlaggedOrders } = guardCensus(files, payload);
  const closed = <K extends string>(keys: readonly K[], counts: ReadonlyMap<K, number>) =>
    Object.fromEntries(keys.map((key) => [key, counts.get(key) ?? 0])) as Record<K, number>;
  const report: CollectPureConvertReport = {
    converter: COLLECTPURE_CONVERTER_NAME,
    snapshot: folder.snapshot !== null,
    capture: { capturedAt, captureDigest, files: folder.files.length },
    sellOrders: {
      listed: consolidated.listedSellOrders,
      converted: orders.length,
      held: salesHeld,
      byStatus,
      agreedDays: agreed.length === 0 ? null : { first: agreed[0], last: agreed[agreed.length - 1] },
    },
    lines: {
      dispositions: tally.dispositions,
      nonMetal: tally.nonMetal,
      byMetal: Object.fromEntries([...tally.byMetal].sort(([a], [b]) => byText(a, b))),
      byPack: Object.fromEntries((['single', 'multiple', 'unknown'] as const).map((pack) => [pack, tally.byPack.get(pack) ?? 0])) as Record<MetalPack, number>,
      byContent: Object.fromEntries([...tally.byContent].sort(([a], [b]) => byText(a, b))),
      stored: tally.stored,
      withheld: tally.withheld,
      productRefs: {
        metal: { stored: tally.productRefs.metal.stored, withheld: closed(COLLECTPURE_PRODUCT_REF_WITHHELD, tally.productRefs.metal.withheld) },
        flagged: { stored: tally.productRefs.flagged.stored, withheld: closed(COLLECTPURE_PRODUCT_REF_WITHHELD, tally.productRefs.flagged.withheld) },
      },
      titlesWithheld: closed(COLLECTPURE_TITLE_WITHHELD, tally.titlesWithheld),
    },
    guard: {
      flaggedLines: tally.flagged,
      byClause: closed(RETAIL_METAL_GUARD_CLAUSES, tally.byClause),
      byFirstEvidence: closed(RETAIL_METAL_GUARD_EVIDENCE, tally.byFirstEvidence),
      byEvidence: closed(RETAIL_METAL_GUARD_EVIDENCE, tally.byEvidence),
      adjacencyOnly: tally.adjacencyOnly,
      flaggedOrders: tally.flaggedOrders,
      mixedOrders: tally.mixedOrders,
      heldAlsoFlaggedOrders,
    },
    census,
    ...metalsOwnerQuestionCounts(payload.orders),
    payouts: {
      listed: consolidated.listedPayouts,
      unreadableRows: consolidated.unreadablePayoutRows,
      historyPages: history.pages,
      historyRows: history.items.length,
      converted: sum(orders.map((order) => order.payouts.length)),
    },
    optionalFees: { ...context.optionalFees },
    rawSellOrders: { files: raw.size, withoutListing: unlisted.length },
    held: heldCounts,
    contractIssues: context.contractIssues,
    coverage,
  };
  return metalsConvertOutput(payload, report);
}

/** The CLI registry's entry for CollectPure (`holdr-metals-convert --source collectpure`). */
export const COLLECTPURE_METALS_CONVERTER: MetalsCaptureConverter = {
  input: 'capture-folder',
  source: 'collectpure',
  folder: COLLECTPURE_ACCOUNT_FOLDER,
  snapshot: COLLECTPURE_SNAPSHOT_FOLDER,
  files: COLLECTPURE_CAPTURE_LAYOUT,
  convert: convertCollectPureCapture,
};
