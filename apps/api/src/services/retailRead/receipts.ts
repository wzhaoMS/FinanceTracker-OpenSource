import type Database from 'better-sqlite3';
import { ITEM_TAXONOMY_V2_VIEW, type ItemTaxonomyV2NodeId } from '@finance-tracker/shared';
import {
  RETAIL_API_CARD_TENDER_KINDS,
  RETAIL_API_CATEGORY_LINE_KINDS,
  RETAIL_API_CHANNELS,
  RETAIL_API_COVERAGE_CHANNELS,
  RETAIL_API_FORMATS,
  RETAIL_API_LINE_EVENT_KINDS,
  RETAIL_API_QUARANTINE_REASONS,
  RETAIL_API_TENDER_KINDS,
  RETAIL_API_VERSIONS,
  type RetailApiCaptureRange,
  type RetailApiChannel,
  type RetailApiCoverageChannel,
  type RetailApiFulfilment,
  type RetailApiLine,
  type RetailApiLineCategory,
  type RetailApiLineEventKind,
  type RetailApiLineEvents,
  type RetailApiLineKind,
  type RetailApiMatchingLine,
  type RetailApiMetal,
  type RetailApiMetalForm,
  type RetailApiMetalGuardEvidence,
  type RetailApiMetalPack,
  type RetailApiNetwork,
  type RetailApiOnlineStatus,
  type RetailApiOwner,
  type RetailApiQuarantineReason,
  type RetailApiReceiptCounts,
  type RetailApiReceiptPresent,
  type RetailApiReceiptRow,
  type RetailApiReceiptState,
  type RetailApiReceiptsPresent,
  type RetailApiRowTenders,
  type RetailApiShipment,
  type RetailApiSign,
  type RetailApiStoredValueKind,
  type RetailApiSummaryPresent,
  type RetailApiTender,
  type RetailApiTenderKind,
  type RetailApiWeightUnit,
} from '@finance-tracker/shared/retail-api';

import { shownItemTitle } from '../../routes/cardTransactions.js';
import {
  readRetailTaxonomyRows,
  retailTaxonomyIndex,
  retailTaxonomyResolver,
  type RetailLineTaxonomy,
  type RetailTaxonomyRow,
} from '../retail/taxonomyResolver.js';

/**
 * The Costco receipts page's reads (`@finance-tracker/shared/retail-api`: the summary and the list v1, the detail v2) over
 * PR 2's retail tables: each route's rows, read with plain SELECTs inside the caller's one read transaction
 * (routes/retail.ts, once `retailSchemaForRead` found the tables present), and pure views that make the route's body of
 * them.
 *
 * Every receipt is read through its canonical version. Quarantined receipts are listed like any other, with their first
 * reason, never hidden. No answer carries a sum across receipts: a receipt's own stated totals, and its own tenders
 * split into what a card paid and what else paid, are the only money, and the summary is counts only. Natural keys and
 * membership facts never leave the database: nothing here reads one out (`held` counts distinct keys in SQL).
 *
 * A line's category (the detail's `lines[].category`, the list's `category` filter) is the retail taxonomy's F for it
 * (Costco 3/7 plan v5 §4.1), from the taxonomy's own resolver (services/retail/taxonomyResolver.ts, the one taxonomy
 * module this reads): the taxonomy's stored rows, read in the same transaction and only for an answer that shows or
 * filters by a category, and the line's merchant, item number, department and title-rule match, as the taxonomy reads
 * them (`readRetailTaxonomySubjects`). Only item, fee and fuel lines carry one. Nothing here stores a category.
 */

/** A membership as the summary names it. */
interface MembershipRow {
  membershipRef: string;
  label: string;
  owner: RetailApiOwner;
}

/** A receipt's identity and selection. */
interface ReceiptStateRow {
  receiptRef: string;
  channel: RetailApiChannel;
  state: RetailApiReceiptState;
  firstReason: RetailApiQuarantineReason | null;
}

/** A membership whose captures hold a receipt (from its observations, each pair once). */
interface ObservedRow {
  receiptRef: string;
  membershipRef: string;
}

/** A receipt with its canonical version's own facts, as the list shows them. */
interface ReceiptListRow extends ReceiptStateRow {
  versionRef: string;
  date: string;
  sign: RetailApiSign;
  status: RetailApiOnlineStatus | null;
  currency: 'USD';
  totalMinor: number;
  itemLines: number;
}

interface TenderRow {
  receiptRef: string;
  kind: RetailApiTenderKind;
  amountMinor: number;
}

export interface RetailSummaryRows {
  /** In registration order. */
  memberships: MembershipRow[];
  imports: Array<{ membershipRef: string; capturedAt: string }>;
  coverage: Array<{ membershipRef: string; channel: RetailApiCoverageChannel; from: string; to: string }>;
  receipts: ReceiptStateRow[];
  observed: ObservedRow[];
  /** Held records with a key, each distinct key once (counted in SQL: no key is read out), and every one without a key. */
  held: { keyed: number; keyless: number };
}

export interface RetailReceiptsRows {
  /** Membership refs, in registration order. */
  memberships: string[];
  receipts: ReceiptListRow[];
  observed: ObservedRow[];
  /** Each receipt's canonical version's tenders, in its order. */
  tenders: TenderRow[];
  /** For a search only: each receipt's canonical version's lines, in its order. */
  lines: SearchLineRow[] | null;
  /**
   * For a category filter only: each receipt's canonical version's lines of the kinds that carry a category, as the
   * taxonomy's resolver reads them, and every stored taxonomy row.
   */
  categories: { lines: CategoryLineRow[]; taxonomy: RetailTaxonomyRow[] } | null;
}

/** A line as a search reads it. */
interface SearchLineRow {
  receiptRef: string;
  lineRef: string;
  kind: RetailApiLineKind;
  itemNumber: string | null;
  title: string | null;
  title2: string | null;
  quantity: number | null;
  unitPriceMinor: number | null;
  amountMinor: number;
}

/** A line as the taxonomy's resolver reads it (`readRetailTaxonomySubjects`' own reading of PR 2's tables). */
interface CategoryLineRow {
  receiptRef: string;
  /** Its receipt's merchant. */
  merchant: string;
  itemNumber: string | null;
  department: number | null;
  /** The title rule matched it: its stored metal evidence (`metal_rule`). */
  titleRule: boolean;
}

/** The list's filters and page, checked by the route; the membership is one the snapshot holds (`retailMembershipExists`). */
export interface RetailReceiptsQuery {
  membership: string | null;
  /** The channels kept (Spending's comma list, each once), or null for every channel. Their order is no order. */
  channels: readonly RetailApiChannel[] | null;
  /** The search (Spending's checked `q`: trimmed, not empty), or null for none. */
  search: string | null;
  /** A node of the shared item tree, v2 (the route's checked `category`), or null for none. */
  category: ItemTaxonomyV2NodeId | null;
  offset: number;
  limit: number;
}

interface LineRow {
  lineRef: string;
  ordinal: number;
  kind: RetailApiLineKind;
  itemNumber: string | null;
  title: string | null;
  title2: string | null;
  department: number | null;
  quantity: number | null;
  unitPriceMinor: number | null;
  amountMinor: number;
  shippingMinor: number | null;
  taxFlag: string | null;
  couponTarget: number | null;
  feeParent: number | null;
  fulfilment: RetailApiFulfilment | null;
  storedValue: RetailApiStoredValueKind | null;
  fuelGallons: string | null;
  fuelUnitPrice: string | null;
  metalRule: string | null;
  metal: RetailApiMetal | null;
  form: RetailApiMetalForm | null;
  statedWeightValue: string | null;
  statedWeightUnit: RetailApiWeightUnit | null;
  pack: RetailApiMetalPack | null;
  uncertainGuard: string | null;
  uncertainMetal: RetailApiMetal | null;
}

interface ReceiptDetailRow extends ReceiptStateRow {
  merchant: string;
  versionRef: string;
  date: string;
  localTime: string | null;
  sign: RetailApiSign;
  status: RetailApiOnlineStatus | null;
  currency: 'USD';
  subtotalMinor: number | null;
  taxMinor: number | null;
  instantSavingsMinor: number | null;
  discountMinor: number | null;
  shippingMinor: number | null;
  feesMinor: number | null;
  storedValueMinor: number | null;
  totalMinor: number;
}

export interface RetailReceiptRows {
  receipt: ReceiptDetailRow;
  /** Its memberships' refs, in registration order. */
  memberships: string[];
  /** By position. */
  legends: Array<{ legend: string; amountMinor: number }>;
  /** By ordinal. */
  lines: LineRow[];
  /** By line, then position. */
  evidence: Array<{ lineRef: string; evidence: RetailApiMetalGuardEvidence }>;
  events: Array<{ lineRef: string; event: RetailApiLineEventKind; quantity: number; date: string }>;
  shipments: Array<{ lineRef: string } & RetailApiShipment>;
  /** By ordinal. */
  tenders: Array<{ kind: RetailApiTenderKind; network: RetailApiNetwork; last4: string | null; amountMinor: number }>;
  /** Every stored taxonomy row, by import sequence: what its lines' categories resolve from. */
  taxonomy: RetailTaxonomyRow[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads: plain SELECTs, inside the caller's read transaction.
// ---------------------------------------------------------------------------------------------------------------------

/** Memberships in registration order: their registering import's sequence, then their ref. */
const MEMBERSHIPS_SQL = `SELECT m.membership_ref AS membershipRef, m.label AS label, m.owner AS owner FROM retail_memberships m
  LEFT JOIN retail_imports i ON i.import_id = m.registered_import ORDER BY i.import_seq IS NULL, i.import_seq, m.membership_ref`;
const OBSERVED_SQL = `SELECT DISTINCT receipt_ref AS receiptRef, membership_ref AS membershipRef FROM retail_receipt_observations
  ORDER BY receipt_ref, membership_ref`;

const readMemberships = (db: Database.Database): MembershipRow[] => db.prepare(MEMBERSHIPS_SQL).all() as MembershipRow[];

/** Whether a membership of this ref is stored: the list's `membership` filter, checked before any filter or page. */
export const retailMembershipExists = (db: Database.Database, membershipRef: string): boolean =>
  db.prepare('SELECT 1 FROM retail_memberships WHERE membership_ref = ?').get(membershipRef) !== undefined;

/** A receipt read with its canonical version. The schema's triggers make one without impossible, so it is never read past. */
function canonical<T extends { versionRef: string | null }>(row: T): T & { versionRef: string } {
  if (row.versionRef === null) throw new TypeError('a retail receipt has no canonical version');
  return row as T & { versionRef: string };
}

export function readRetailSummary(db: Database.Database): RetailSummaryRows {
  return {
    memberships: readMemberships(db),
    imports: db.prepare('SELECT membership_ref AS membershipRef, captured_at AS capturedAt FROM retail_imports ORDER BY import_seq')
      .all() as RetailSummaryRows['imports'],
    coverage: db.prepare(`SELECT i.membership_ref AS membershipRef, c.channel AS channel, c.from_date AS "from", c.to_date AS "to"
        FROM retail_import_coverage c JOIN retail_imports i ON i.import_id = c.import_id ORDER BY i.import_seq, c.channel, c.position`)
      .all() as RetailSummaryRows['coverage'],
    receipts: db.prepare('SELECT receipt_ref AS receiptRef, channel, state, first_reason AS firstReason FROM retail_receipts ORDER BY receipt_ref')
      .all() as ReceiptStateRow[],
    observed: db.prepare(OBSERVED_SQL).all() as ObservedRow[],
    held: db.prepare(`SELECT (SELECT count(DISTINCT natural_key) FROM retail_held WHERE natural_key IS NOT NULL) AS keyed,
        (SELECT count(*) FROM retail_held WHERE natural_key IS NULL) AS keyless`).get() as RetailSummaryRows['held'],
  };
}

export function readRetailReceipts(db: Database.Database, read: { lines?: boolean; categories?: boolean } = {}): RetailReceiptsRows {
  const receipts = db.prepare(`SELECT r.receipt_ref AS receiptRef, r.channel AS channel, r.state AS state, r.first_reason AS firstReason,
      v.version_ref AS versionRef, v.date AS date, v.sign AS sign, v.status AS status, v.currency AS currency, v.total_minor AS totalMinor,
      (SELECT count(*) FROM retail_line_facts f WHERE f.version_ref = v.version_ref AND f.kind = 'item') AS itemLines
    FROM retail_receipts r LEFT JOIN retail_receipt_versions v ON v.version_ref = r.canonical_version AND v.receipt_ref = r.receipt_ref
    ORDER BY r.receipt_ref`).all() as Array<Omit<ReceiptListRow, 'versionRef'> & { versionRef: string | null }>;
  return {
    memberships: readMemberships(db).map((membership) => membership.membershipRef),
    receipts: receipts.map(canonical),
    observed: db.prepare(OBSERVED_SQL).all() as ObservedRow[],
    tenders: db.prepare(`SELECT r.receipt_ref AS receiptRef, t.kind AS kind, t.amount_minor AS amountMinor
      FROM retail_receipts r JOIN retail_tender_facts t ON t.version_ref = r.canonical_version ORDER BY r.receipt_ref, t.ordinal`).all() as TenderRow[],
    lines: read.lines === true ? db.prepare(`SELECT r.receipt_ref AS receiptRef, f.line_ref AS lineRef, f.kind AS kind, f.item_number AS itemNumber,
        f.title AS title, f.title2 AS title2, f.quantity AS quantity, f.unit_price_minor AS unitPriceMinor, f.amount_minor AS amountMinor
      FROM retail_receipts r JOIN retail_line_facts f ON f.version_ref = r.canonical_version ORDER BY r.receipt_ref, f.ordinal`).all() as SearchLineRow[]
      : null,
    categories: read.categories === true ? { lines: readCategoryLines(db), taxonomy: readRetailTaxonomyRows(db) } : null,
  };
}

/** The line kinds that carry a category, as an SQL list (the contract's constants). */
const CATEGORY_KINDS_SQL = RETAIL_API_CATEGORY_LINE_KINDS.map((kind) => `'${kind}'`).join(', ');

/** Each receipt's canonical lines that carry a category, as the taxonomy reads them (`readRetailTaxonomySubjects`). */
function readCategoryLines(db: Database.Database): CategoryLineRow[] {
  return (db.prepare(`SELECT r.receipt_ref AS receiptRef, r.merchant AS merchant, f.item_number AS itemNumber, f.department AS department,
      f.metal_rule IS NOT NULL AS titleRule
    FROM retail_receipts r JOIN retail_line_facts f ON f.version_ref = r.canonical_version
    WHERE f.kind IN (${CATEGORY_KINDS_SQL}) ORDER BY r.receipt_ref, f.ordinal`).all() as Array<Omit<CategoryLineRow, 'titleRule'> & { titleRule: number }>)
    .map((line) => ({ ...line, titleRule: line.titleRule === 1 }));
}

/** One receipt's rows, by its ref, or null when no receipt has it. */
export function readRetailReceipt(db: Database.Database, receiptRef: string): RetailReceiptRows | null {
  const row = db.prepare(`SELECT r.receipt_ref AS receiptRef, r.channel AS channel, r.state AS state, r.first_reason AS firstReason,
      r.merchant AS merchant, v.version_ref AS versionRef, v.date AS date, v.local_time AS localTime, v.sign AS sign, v.status AS status,
      v.currency AS currency, v.subtotal_minor AS subtotalMinor, v.tax_minor AS taxMinor, v.instant_savings_minor AS instantSavingsMinor,
      v.discount_minor AS discountMinor, v.shipping_minor AS shippingMinor, v.fees_minor AS feesMinor, v.stored_value_minor AS storedValueMinor,
      v.total_minor AS totalMinor
    FROM retail_receipts r LEFT JOIN retail_receipt_versions v ON v.version_ref = r.canonical_version AND v.receipt_ref = r.receipt_ref
    WHERE r.receipt_ref = ?`).get(receiptRef) as (Omit<ReceiptDetailRow, 'versionRef'> & { versionRef: string | null }) | undefined;
  if (row === undefined) return null;
  const receipt = canonical(row);
  const version = receipt.versionRef;
  const observed = db.prepare('SELECT DISTINCT membership_ref FROM retail_receipt_observations WHERE receipt_ref = ?').pluck()
    .all(receiptRef) as string[];
  return {
    receipt,
    memberships: inRegistrationOrder(observed, readMemberships(db).map((membership) => membership.membershipRef)),
    legends: db.prepare('SELECT legend, amount_minor AS amountMinor FROM retail_tax_legends WHERE version_ref = ? ORDER BY position')
      .all(version) as RetailReceiptRows['legends'],
    lines: db.prepare(`SELECT line_ref AS lineRef, ordinal, kind, item_number AS itemNumber, title, title2, department, quantity,
        unit_price_minor AS unitPriceMinor, amount_minor AS amountMinor, shipping_minor AS shippingMinor, tax_flag AS taxFlag,
        coupon_target AS couponTarget, fee_parent AS feeParent, fulfilment, stored_value AS storedValue, fuel_gallons AS fuelGallons,
        fuel_unit_price AS fuelUnitPrice, metal_rule AS metalRule, metal, form, stated_weight_value AS statedWeightValue,
        stated_weight_unit AS statedWeightUnit, pack, uncertain_guard AS uncertainGuard, uncertain_metal AS uncertainMetal
      FROM retail_line_facts WHERE version_ref = ? ORDER BY ordinal`).all(version) as LineRow[],
    evidence: db.prepare('SELECT line_ref AS lineRef, evidence FROM retail_line_uncertain_evidence WHERE version_ref = ? ORDER BY line_ref, position')
      .all(version) as RetailReceiptRows['evidence'],
    events: db.prepare(`SELECT line_ref AS lineRef, event, quantity, date FROM retail_line_events WHERE version_ref = ?
      ORDER BY line_ref, event, position`).all(version) as RetailReceiptRows['events'],
    shipments: db.prepare(`SELECT line_ref AS lineRef, shipment_ref AS shipmentRef, shipped_date AS shippedDate, delivered_date AS deliveredDate,
        estimated_arrival_date AS estimatedArrivalDate, carrier FROM retail_shipment_facts WHERE version_ref = ? ORDER BY line_ref, position`)
      .all(version) as RetailReceiptRows['shipments'],
    tenders: db.prepare('SELECT kind, network, last4, amount_minor AS amountMinor FROM retail_tender_facts WHERE version_ref = ? ORDER BY ordinal')
      .all(version) as RetailReceiptRows['tenders'],
    taxonomy: readRetailTaxonomyRows(db),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Views: pure, over the rows above.
// ---------------------------------------------------------------------------------------------------------------------

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Distinct refs in registration order (`order`); any it doesn't name come last, by ref. */
function inRegistrationOrder(refs: Iterable<string>, order: readonly string[]): string[] {
  const rank = new Map(order.map((ref, index) => [ref, index]));
  return [...new Set(refs)].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || byText(a, b));
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group === undefined) groups.set(key(row), [row]);
    else group.push(row);
  }
  return groups;
}

/** Receipts by channel and state, every channel and state listed (contract order). */
function receiptCounts(receipts: Iterable<ReceiptStateRow>): RetailApiReceiptCounts {
  const counts = {} as RetailApiReceiptCounts;
  for (const channel of RETAIL_API_CHANNELS) counts[channel] = { active: 0, quarantined: 0 };
  for (const receipt of receipts) counts[receipt.channel][receipt.state] += 1;
  return counts;
}

const DAY_MS = 86_400_000;
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/**
 * A membership's coverage ranges, each channel's merged where they overlap or touch (the next starts no later than the
 * day after one ends): by channel (contract order), then `from`.
 */
function captureRanges(coverage: ReadonlyArray<{ channel: RetailApiCoverageChannel; from: string; to: string }>): RetailApiCaptureRange[] {
  return RETAIL_API_COVERAGE_CHANNELS.flatMap((channel) => {
    const ranges = coverage.filter((range) => range.channel === channel)
      .map((range): RetailApiCaptureRange => ({ channel, from: range.from, to: range.to }))
      .sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to));
    const merged: RetailApiCaptureRange[] = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last !== undefined && dayNumber(range.from) <= dayNumber(last.to) + 1) {
        if (range.to > last.to) last.to = range.to;
      } else {
        merged.push(range);
      }
    }
    return merged;
  });
}

/**
 * The latest capture over a membership's imports: their greatest `captured_at` (a 24-character instant, so the greatest
 * text is the latest time), as its day; never simply the newest import's, since an older capture can be imported later.
 * Null when there is no import.
 */
function capturedThrough(imports: ReadonlyArray<{ capturedAt: string }>): string | null {
  let latest: string | null = null;
  for (const entry of imports) {
    if (latest === null || entry.capturedAt > latest) latest = entry.capturedAt;
  }
  return latest === null ? null : latest.slice(0, 10);
}

/** `GET /retail/costco/summary`: counts only. */
export function retailSummaryView(rows: RetailSummaryRows): RetailApiSummaryPresent {
  const receipts = new Map(rows.receipts.map((receipt) => [receipt.receiptRef, receipt]));
  const observed = groupBy(rows.observed, (row) => row.membershipRef);
  const coverage = groupBy(rows.coverage, (range) => range.membershipRef);
  const imports = groupBy(rows.imports, (entry) => entry.membershipRef);
  const quarantine = Object.fromEntries(RETAIL_API_QUARANTINE_REASONS.map((reason) => [reason, 0])) as Record<RetailApiQuarantineReason, number>;
  for (const receipt of rows.receipts) {
    if (receipt.state === 'quarantined' && receipt.firstReason !== null) quarantine[receipt.firstReason] += 1;
  }
  return {
    format: RETAIL_API_FORMATS.summary,
    version: RETAIL_API_VERSIONS.summary,
    state: 'present',
    memberships: rows.memberships.map((membership) => {
      const own = new Set((observed.get(membership.membershipRef) ?? []).map((row) => row.receiptRef));
      return {
        membershipRef: membership.membershipRef,
        label: membership.label,
        owner: membership.owner,
        receipts: receiptCounts([...own].flatMap((receiptRef) => receipts.get(receiptRef) ?? [])),
        capture: {
          ranges: captureRanges(coverage.get(membership.membershipRef) ?? []),
          capturedThrough: capturedThrough(imports.get(membership.membershipRef) ?? []),
        },
      };
    }),
    receipts: receiptCounts(rows.receipts),
    quarantine,
    held: rows.held.keyed + rows.held.keyless,
  };
}

const isCardTender = (kind: RetailApiTenderKind): boolean => (RETAIL_API_CARD_TENDER_KINDS as readonly string[]).includes(kind);

/** How one receipt was paid, from its own tenders only: the kinds present, and its card and other tenders, each added up. */
function rowTenders(tenders: readonly TenderRow[]): RetailApiRowTenders {
  const kinds = new Set(tenders.map((tender) => tender.kind));
  let cardSpendingMinor = 0;
  let otherMinor = 0;
  for (const tender of tenders) {
    if (isCardTender(tender.kind)) cardSpendingMinor += tender.amountMinor;
    else otherMinor += tender.amountMinor;
  }
  return { kinds: RETAIL_API_TENDER_KINDS.filter((kind) => kinds.has(kind)), cardSpendingMinor, otherMinor };
}

/** A search's amount (`12.34`, `$12.34`, `$12`, `1,234.56`), in cents; null when it reads as text only (`1234`). */
const SEARCH_AMOUNT = /^(\$)?(\d{1,9}|\d{1,3}(?:,\d{3}){1,2})(?:\.(\d{2}))?$/;
function searchAmount(search: string): number | null {
  const match = search.match(SEARCH_AMOUNT);
  if (match === null || (match[1] === undefined && match[3] === undefined)) return null;
  return Number(match[2].replace(/,/g, '')) * 100 + Number(match[3] ?? '0');
}

/**
 * The lines a search matches, in the receipt's order: a shown title or second description, or the item number, holding
 * the search (any case, its spaces collapsed as PR 2's text rule stores titles), or an amount equal to the line's amount
 * or unit price (either sign). A title the API doesn't show is never searched.
 */
function searchLines(lines: readonly SearchLineRow[], search: string): RetailApiMatchingLine[] {
  const needle = search.replace(/\s+/g, ' ').toLowerCase();
  const amount = searchAmount(search);
  return lines.flatMap((line) => {
    const title = shownItemTitle(line.title);
    const title2 = shownItemTitle(line.title2);
    const hit = [title, title2, line.itemNumber].some((value) => value !== null && value.toLowerCase().includes(needle))
      || (amount !== null && (Math.abs(line.amountMinor) === amount || (line.unitPriceMinor !== null && Math.abs(line.unitPriceMinor) === amount)));
    return hit ? [{ lineRef: line.lineRef, kind: line.kind, itemNumber: line.itemNumber, title, title2, quantity: line.quantity,
      amountMinor: line.amountMinor }] : [];
  });
}

/** Date descending, then receipt ref. */
const newestFirst = (a: ReceiptListRow, b: ReceiptListRow): number => byText(b.date, a.date) || byText(a.receiptRef, b.receiptRef);

const CATEGORY_KINDS: ReadonlySet<RetailApiLineKind> = new Set(RETAIL_API_CATEGORY_LINE_KINDS);

/** A line's category: the resolver's F for it, with its node's card category in the v2 tree, in the contract's key order. */
function lineCategory(resolved: RetailLineTaxonomy): RetailApiLineCategory {
  return {
    node: resolved.node,
    cardCategory: ITEM_TAXONOMY_V2_VIEW.node(resolved.node)!.cardCategory,
    source: resolved.source,
    confidenceBp: resolved.confidenceBp,
    suggested: resolved.suggested,
    suggestion: resolved.suggestion === null ? null : { node: resolved.suggestion.node, confidenceBp: resolved.suggestion.confidenceBp },
    metalHold: resolved.metalHold,
  };
}

/** Whether a line's node is the category, or, when the category is a top level, one of its subcategories. */
const inCategory = (node: ItemTaxonomyV2NodeId, category: ItemTaxonomyV2NodeId): boolean =>
  node === category || (ITEM_TAXONOMY_V2_VIEW.isTop(category) && ITEM_TAXONOMY_V2_VIEW.top(node) === category);

/** The receipts with at least one canonical line the category files: each line's node from the resolver over the stored rows. */
function receiptsInCategory(rows: RetailReceiptsRows, category: ItemTaxonomyV2NodeId): Set<string> {
  if (rows.categories === null) throw new TypeError('a retail category filter needs its lines read');
  const resolver = retailTaxonomyResolver(retailTaxonomyIndex(rows.categories.taxonomy));
  const kept = new Set<string>();
  for (const line of rows.categories.lines) {
    if (!kept.has(line.receiptRef) && inCategory(resolver.line(line).node, category)) kept.add(line.receiptRef);
  }
  return kept;
}

/** `GET /retail/costco/receipts`: the receipts the filters match, date descending then ref, one page of them. */
export function retailReceiptsPage(rows: RetailReceiptsRows, query: RetailReceiptsQuery): RetailApiReceiptsPresent {
  const memberships = new Map([...groupBy(rows.observed, (row) => row.receiptRef)]
    .map(([receiptRef, observed]) => [receiptRef, inRegistrationOrder(observed.map((row) => row.membershipRef), rows.memberships)]));
  const lines = groupBy(rows.lines ?? [], (line) => line.receiptRef);
  const search = query.search;
  const found = new Map(search === null ? [] : rows.receipts.map((receipt) =>
    [receipt.receiptRef, searchLines(lines.get(receipt.receiptRef) ?? [], search)] as const));
  const categorized = query.category === null ? null : receiptsInCategory(rows, query.category);
  const matching = rows.receipts
    .filter((receipt) => (query.channels === null || query.channels.includes(receipt.channel))
      && (query.membership === null || (memberships.get(receipt.receiptRef) ?? []).includes(query.membership))
      && (search === null || (found.get(receipt.receiptRef) ?? []).length > 0)
      && (categorized === null || categorized.has(receipt.receiptRef)))
    .sort(newestFirst);
  const page = matching.slice(query.offset, query.offset + query.limit);
  const tenders = groupBy(rows.tenders, (tender) => tender.receiptRef);
  return {
    format: RETAIL_API_FORMATS.receipts,
    version: RETAIL_API_VERSIONS.receipts,
    state: 'present',
    total: matching.length,
    offset: query.offset,
    limit: query.limit,
    receipts: page.map((receipt): RetailApiReceiptRow => ({
      receiptRef: receipt.receiptRef,
      channel: receipt.channel,
      sign: receipt.sign,
      status: receipt.status,
      date: receipt.date,
      currency: receipt.currency,
      totalMinor: receipt.totalMinor,
      itemLines: receipt.itemLines,
      memberships: memberships.get(receipt.receiptRef) ?? [],
      state: receipt.state,
      quarantineReason: receipt.firstReason,
      tenders: rowTenders(tenders.get(receipt.receiptRef) ?? []),
      matchingLines: search === null ? null : found.get(receipt.receiptRef) ?? [],
    })),
  };
}

/** `GET /retail/costco/receipts/:ref`: one receipt, as its canonical version states it, each line with its category. */
export function retailReceiptView(rows: RetailReceiptRows): RetailApiReceiptPresent {
  const { receipt } = rows;
  const online = receipt.channel === 'online';
  const refAt = new Map(rows.lines.map((line) => [line.ordinal, line.lineRef]));
  const lineAt = (ordinal: number | null): string | null => (ordinal === null ? null : refAt.get(ordinal) ?? null);
  const evidence = groupBy(rows.evidence, (row) => row.lineRef);
  const events = groupBy(rows.events, (row) => row.lineRef);
  const shipments = groupBy(rows.shipments, (row) => row.lineRef);
  const lineEvents = (lineRef: string): RetailApiLineEvents => {
    const own = events.get(lineRef) ?? [];
    return Object.fromEntries(RETAIL_API_LINE_EVENT_KINDS.map((kind) => [kind,
      own.filter((event) => event.event === kind).map((event) => ({ quantity: event.quantity, date: event.date }))])) as RetailApiLineEvents;
  };
  const resolver = retailTaxonomyResolver(retailTaxonomyIndex(rows.taxonomy));
  // An item, fee or fuel line's F, read as the taxonomy reads a line; a coupon has none (it shows under its item).
  const categoryOf = (line: LineRow): RetailApiLineCategory | null => (CATEGORY_KINDS.has(line.kind)
    ? lineCategory(resolver.line({ merchant: receipt.merchant, itemNumber: line.itemNumber, department: line.department,
      titleRule: line.metalRule !== null }))
    : null);
  return {
    format: RETAIL_API_FORMATS.receipt,
    version: RETAIL_API_VERSIONS.receipt,
    state: 'present',
    receipt: {
      receiptRef: receipt.receiptRef,
      channel: receipt.channel,
      state: receipt.state,
      quarantineReason: receipt.firstReason,
      memberships: rows.memberships,
      date: receipt.date,
      localTime: receipt.localTime,
      sign: receipt.sign,
      status: receipt.status,
      currency: receipt.currency,
      totals: {
        subtotalMinor: receipt.subtotalMinor,
        taxMinor: receipt.taxMinor,
        instantSavingsMinor: receipt.instantSavingsMinor,
        discountMinor: receipt.discountMinor,
        shippingMinor: receipt.shippingMinor,
        feesMinor: receipt.feesMinor,
        storedValueMinor: receipt.storedValueMinor,
        totalMinor: receipt.totalMinor,
      },
      taxLegends: rows.legends.map((legend) => ({ legend: shownItemTitle(legend.legend), amountMinor: legend.amountMinor })),
      lines: rows.lines.map((line): RetailApiLine => ({
        lineRef: line.lineRef,
        kind: line.kind,
        itemNumber: line.itemNumber,
        title: shownItemTitle(line.title),
        title2: shownItemTitle(line.title2),
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        amountMinor: line.amountMinor,
        shippingMinor: line.shippingMinor,
        taxFlag: line.taxFlag,
        storedValue: line.storedValue,
        fulfilment: line.fulfilment,
        fuel: line.kind === 'fuel' ? { gallons: line.fuelGallons, unitPrice: line.fuelUnitPrice } : null,
        couponFor: lineAt(line.couponTarget),
        feeOf: lineAt(line.feeParent),
        metal: line.metalRule === null ? null : {
          metal: line.metal,
          form: line.form,
          statedWeight: line.statedWeightValue !== null && line.statedWeightUnit !== null
            ? { value: line.statedWeightValue, unit: line.statedWeightUnit } : null,
          pack: line.pack as RetailApiMetalPack,
          rule: line.metalRule,
        },
        metalUncertain: line.uncertainGuard === null ? null : {
          guard: line.uncertainGuard,
          evidence: (evidence.get(line.lineRef) ?? []).map((row) => row.evidence),
          metal: line.uncertainMetal,
        },
        events: online ? lineEvents(line.lineRef) : null,
        shipments: online ? (shipments.get(line.lineRef) ?? []).map((row): RetailApiShipment => ({
          shipmentRef: row.shipmentRef,
          shippedDate: row.shippedDate,
          deliveredDate: row.deliveredDate,
          estimatedArrivalDate: row.estimatedArrivalDate,
          carrier: row.carrier,
        })) : [],
        category: categoryOf(line),
      })),
      tenders: rows.tenders.map((tender): RetailApiTender => ({
        kind: tender.kind,
        network: tender.network,
        last4: tender.last4,
        amountMinor: tender.amountMinor,
        cardSpending: isCardTender(tender.kind),
      })),
    },
  };
}
