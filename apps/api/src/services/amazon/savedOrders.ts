import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Database } from 'better-sqlite3';
import { HoldrRefusal } from '../dbErrors.js';
import { itemBlockReconciles, readOrderHistory } from './allocation.js';
import type { ValidatedCapture } from './capture.js';
import type { FreshSection } from './freshImport.js';
import { audit, writeValidatedCapture, type ImportReceipt } from './importer.js';
import { readSubjects } from './matcher.js';
import { recordOrderChannel } from './orderChannels.js';
import { day, digest, minor, opaque, SOURCE, TIP_SPLIT_POLICY_DIGEST } from './policy.js';
import { validTitle } from './products.js';
import { ledgerChargeProof, ledgerGateContext, type LedgerGateContext, type SavedGateLedger } from './savedLedgerGate.js';
// The settle moved to settle.ts with the rest of the Amazon settle; still exported from here.
import { linkedCardRows, settleAmazon } from './settle.js';
export { linkedCardRows, settleAmazon };
import { singleCardProven } from './tender.js';
import { splitRef } from './tipSplit.js';
import type { MatchResult, MatchSubject, Money, OrderObservation, Staging } from './types.js';

/**
 * Amazon orders read offline from saved pages (`holdr.amazon-saved-orders` v1, the "dumb path", Root 2026-10-24): the
 * parser's private output from rendered order pages an operator saved one by one, for orders the live producer could
 * not itemize. Each order is one complete, single-card, to-the-cent read: its summary, its one card, and either its
 * classic item lines or its Amazon Fresh Item List.
 *
 * Every order is checked against a closed shape and the importer's own rules (`singleCardProven`, `itemBlockReconciles`,
 * and the producer kit's own Fresh line and list validator, which the Fresh import's `freshLineRecord` re-checks when it
 * writes), order by order: an invalid order
 * is set aside by its place and a closed reason, and the valid ones go on (Root: per-order isolation). Valid orders
 * become ONE synthetic v3 capture written through the importer's write path (`writeValidatedCapture`), so every display,
 * history, refund, owner-decision and match rule applies unchanged. It is a `backfill` run whose run ID and digest
 * derive from the orders it writes, so the same orders import once.
 *
 * Root's gate judges each order on its OWN incoming evidence (`savedOrdersGate`): its saved card, total and date must
 * link to exactly one card charge in Holdr (the matcher's `unique` link: the bound last-4, the amount, the settlement
 * window; for a tipped Amazon Fresh order whose total has no charge, its total minus tip, TIP_SPLIT_POLICY), as the
 * order's own display, with no conflict in its history. An order already shown from the kit whose saved
 * read conflicts on card, date or total is history only, and so held. A held order changes nothing: `importSavedOrders`
 * judges every order on a rolled-back trial write and then writes only those that passed. No card row linked before may
 * be lost or moved.
 */
export const SAVED_ORDERS_FORMAT = 'holdr.amazon-saved-orders';
export const SAVED_ORDERS_MAX = 400;
/** Bytes a saved-orders file may have (its CLI reader's cap). */
export const SAVED_ORDERS_BYTES = 8 * 1024 * 1024;
const SAVED_TIME_ZONE = 'America/Los_Angeles';
const FAMILIES = ['uff', 'fopo', 'classic'] as const;
const PAGE_KINDS = ['details', 'uff-details', 'itemmod', 'invoice'] as const;
const NETWORKS = ['visa', 'mastercard', 'amex', 'discover'] as const;
const SUMMARY_KINDS = ['items-subtotal', 'shipping', 'tax', 'tip', 'promotion', 'grand-total'] as const;
const REQUIRED_KINDS = ['items-subtotal', 'shipping', 'tax', 'grand-total'];
const HEX64 = /^[a-f0-9]{64}$/;
const ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;

type SummaryKind = typeof SUMMARY_KINDS[number];
export interface SavedOrder {
  orderId: string;
  date: string;
  family: typeof FAMILIES[number];
  total: Money;
  summary: Array<{ kind: SummaryKind; money: Money }>;
  payment: { kind: 'card'; network: typeof NETWORKS[number]; last4: string };
  items: Array<{ lineOrdinal: number; itemId: string | null; title: string; quantity: number; unitPrice: Money }> | null;
  fresh: { statedCount: number | null; rows: number; lines: unknown[] } | null;
  pages: Array<{ kind: typeof PAGE_KINDS[number]; sha256: string }>;
}
export interface SavedOrdersFile {
  format: typeof SAVED_ORDERS_FORMAT;
  version: 1;
  provenance: { targetsSha256: string; indexSha256: string; parser: { name: string; version: string; sha256: string } };
  orders: SavedOrder[];
}
/** A refused saved-orders file: the order's place in it (null: the file itself) and a closed reason. Never a value. */
export class SavedOrdersRefusal extends HoldrRefusal {
  constructor(readonly index: number | null, readonly reason: string) {
    super('amazon saved orders refused');
  }
}
const fail = (index: number | null, reason: string): never => { throw new SavedOrdersRefusal(index, reason); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keysAre = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => isObject(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const hex = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);
const usd = (v: unknown, min = 0): v is Money => keysAre(v, ['currency', 'amountMinor']) && v.currency === 'USD'
  && minor(v.amountMinor) && v.amountMinor >= min && v.amountMinor <= 100_000_000;
const amount = (summary: SavedOrder['summary'], kind: SummaryKind) => summary.find(s => s.kind === kind)?.money.amountMinor ?? 0;

type FreshValidator = (fresh: unknown, staging: unknown) => unknown;
let kitFreshValidator: FreshValidator | undefined;
/** The producer kit's own Fresh Item List validator (tools/amazon-capture/amazon-fresh-items.mjs). */
async function freshValidator(): Promise<FreshValidator> {
  if (!kitFreshValidator) {
    const url = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..',
      'tools', 'amazon-capture', 'amazon-fresh-items.mjs')).href;
    const validate: unknown = (await import(url)).validateAmazonFreshItemLists;
    if (typeof validate !== 'function') throw new HoldrRefusal('amazon fresh validator unavailable');
    kitFreshValidator = validate as FreshValidator;
  }
  return kitFreshValidator;
}

/** The staged observation of one saved order: single-card proven, its items (none for Fresh) proven complete. */
function observation(o: SavedOrder): OrderObservation {
  return {
    orderId: o.orderId, date: o.date, total: { currency: 'USD', amountMinor: o.total.amountMinor },
    items: (o.items ?? []).map(i => ({ lineOrdinal: i.lineOrdinal, itemId: i.itemId, title: i.title, quantity: i.quantity,
      unitPrice: { currency: 'USD', amountMinor: i.unitPrice.amountMinor } })),
    paymentCoverage: { status: 'held', reason: 'selector-failed' },
    paymentMethods: [{ kind: 'card', network: o.payment.network, last4: o.payment.last4 }],
    // In the native producer's own order (amazon-native.mjs readSummary): the page's rows as the saved file lists them,
    // then the promotion it sums, appended last; so a later native re-read serializes the same (#230's guard).
    summary: [...o.summary.filter(s => s.kind !== 'promotion'), ...o.summary.filter(s => s.kind === 'promotion')]
      .map(s => ({ kind: s.kind, money: { currency: 'USD', amountMinor: s.money.amountMinor } })),
    tenderCoverage: 'single-card-proven',
    tenderProof: { methodComplete: true, summaryComplete: true, unknownMethod: false, unknownSummary: false, conflict: false },
    // A Fresh order stages no item lines (its lines are its Item List): as the producer stages one, whose details rows are
    // all unpriced (amazon-native.mjs: those rows are unknown lines, then dropped), its item block is unproven, unknown.
    itemProof: { complete: o.items !== null, unknownLine: o.items === null, conflict: false },
  };
}
/** The Fresh section of the saved orders' capture: each Fresh order's whole Item List (reconciled, unless checking). */
function freshSection(orders: readonly SavedOrder[], reconciled = true): FreshSection {
  const lists: FreshSection['lists'] = [], diagnostics: unknown[] = [];
  orders.forEach((o, ordinal) => {
    if (!o.fresh) return;
    lists.push({ orderId: o.orderId, statedCount: o.fresh.statedCount, rows: o.fresh.rows,
      proof: { complete: true, unreadRows: 0 }, reconciled, lines: o.fresh.lines });
    diagnostics.push({ ordinal, status: 'read', reason: null, rows: o.fresh.rows, lines: o.fresh.lines.length, unread: [] });
  });
  return { format: 'holdr.amazon-fresh-item-lists', version: 1, lists, diagnostics };
}
function checkOrder(value: unknown, index: number, latest: string, validate: FreshValidator): void {
  if (!keysAre(value, ['orderId', 'date', 'family', 'total', 'summary', 'payment', 'items', 'fresh', 'pages'])) return fail(index, 'order-shape');
  const o = value;
  if (typeof o.orderId !== 'string' || !ORDER_ID.test(o.orderId)) return fail(index, 'order-id');
  if (!day(o.date) || o.date < '2000-01-01' || o.date > latest) return fail(index, 'date');
  if (!FAMILIES.includes(o.family as SavedOrder['family'])) return fail(index, 'family');
  if (!usd(o.total, 1)) return fail(index, 'total');
  if (!Array.isArray(o.summary) || o.summary.length < 1 || o.summary.length > SUMMARY_KINDS.length) {
    return fail(index, 'summary-shape');
  }
  const kinds = new Set<string>();
  for (const s of o.summary) {
    if (!keysAre(s, ['kind', 'money']) || !SUMMARY_KINDS.includes(s.kind as SummaryKind) || kinds.has(s.kind as string)
      || !usd(s.money)) return fail(index, 'summary-shape');
    kinds.add(s.kind as string);
  }
  if (REQUIRED_KINDS.some(k => !kinds.has(k))) return fail(index, 'summary-required');
  const summary = o.summary as SavedOrder['summary'];
  if (amount(summary, 'grand-total') !== (o.total as Money).amountMinor) return fail(index, 'summary-total');
  const p = o.payment;
  if (!keysAre(p, ['kind', 'network', 'last4']) || p.kind !== 'card' || !NETWORKS.includes(p.network as typeof NETWORKS[number])
    || typeof p.last4 !== 'string' || !/^\d{4}$/.test(p.last4)) return fail(index, 'payment');
  if (!Array.isArray(o.pages) || o.pages.length < 1 || o.pages.length > PAGE_KINDS.length) return fail(index, 'pages');
  const pageKinds = new Set<string>();
  for (const page of o.pages) {
    if (!keysAre(page, ['kind', 'sha256']) || !PAGE_KINDS.includes(page.kind as typeof PAGE_KINDS[number])
      || pageKinds.has(page.kind as string) || !hex(page.sha256)) return fail(index, 'pages');
    pageKinds.add(page.kind as string);
  }
  if ((o.items === null) === (o.fresh === null)) return fail(index, 'items-or-fresh');
  const subtotal = BigInt(amount(summary, 'items-subtotal'));
  if (o.items !== null) {
    if (!Array.isArray(o.items) || o.items.length < 1 || o.items.length > 100) return fail(index, 'item-shape');
    o.items.forEach((item: unknown, n: number) => {
      if (!keysAre(item, ['lineOrdinal', 'itemId', 'title', 'quantity', 'unitPrice']) || item.lineOrdinal !== n
        || (item.itemId !== null && (typeof item.itemId !== 'string' || !/^[A-Z0-9]{10}$/.test(item.itemId)))
        || !validTitle(item.title) || !Number.isSafeInteger(item.quantity) || (item.quantity as number) < 1
        || (item.quantity as number) > 999 || !usd(item.unitPrice)) fail(index, 'item-shape');
    });
    const items = o.items as NonNullable<SavedOrder['items']>;
    if (items.reduce((n, i) => n + BigInt(i.quantity) * BigInt(i.unitPrice.amountMinor), 0n) !== subtotal) {
      return fail(index, 'item-arithmetic');
    }
  } else {
    const f = o.fresh;
    if (!keysAre(f, ['statedCount', 'rows', 'lines']) || !Number.isSafeInteger(f.rows) || (f.rows as number) < 1
      || (f.rows as number) > 200 || (f.statedCount !== null && f.statedCount !== f.rows)
      || !Array.isArray(f.lines) || f.lines.length !== f.rows) return fail(index, 'fresh-shape');
    // Every line's grammar, by the producer kit's own validator (a strict superset of what the Fresh import re-checks
    // with freshLineRecord when it writes); unreconciled here, since the sum is judged next, on its own.
    const shaped = o as unknown as SavedOrder;
    try { validate(freshSection([shaped], false), { version: 3, orders: [observation(shaped)] }); } catch {
      return fail(index, 'fresh-line');
    }
    // A delivered line always has a price (the kit's line rule: only a missing line's price is null).
    const delivered = (f.lines as Array<{ status: string; linePrice: Money | null }>).filter(line => line.status !== 'missing');
    if (!delivered.length || delivered.reduce((n, line) => n + BigInt(line.linePrice!.amountMinor), 0n) !== subtotal) {
      return fail(index, 'fresh-arithmetic');
    }
  }
  const saved = o as unknown as SavedOrder;
  const order = observation(saved);
  if (!singleCardProven(order)) return fail(index, 'order-arithmetic');
  if (saved.items !== null && !itemBlockReconciles(order)) return fail(index, 'item-arithmetic');
  if (saved.fresh !== null) {
    // The kit's own rules for the list (every line's grammar and the list's reconciliation), against this order alone.
    try { validate(freshSection([saved]), { version: 3, orders: [order] }); } catch { return fail(index, 'fresh-line'); }
  }
}
export interface SavedRejection { index: number; reason: string }
/** A checked file: its valid orders (in file order), each one's place in the input, and every invalid order's place. */
export interface ParsedSavedOrders { file: SavedOrdersFile; indexes: number[]; rejected: SavedRejection[] }
/**
 * The saved-orders file, checked order by order (Root: per-order isolation). A file outside the closed envelope
 * (format, provenance, order count) refuses whole (`SavedOrdersRefusal` with a null place). An order outside the closed
 * shape or the importer's rules, and every order sharing its order ID with another, is set aside under its place and a
 * closed reason, and the valid orders go on. `today` (YYYY-MM-DD) bounds order dates (one day of slack).
 */
export async function parseSavedOrders(value: unknown, today: string): Promise<ParsedSavedOrders> {
  if (!keysAre(value, ['format', 'version', 'provenance', 'orders']) || value.format !== SAVED_ORDERS_FORMAT
    || value.version !== 1) return fail(null, 'file-shape');
  const p = value.provenance;
  if (!keysAre(p, ['targetsSha256', 'indexSha256', 'parser']) || !hex(p.targetsSha256) || !hex(p.indexSha256)
    || !keysAre(p.parser, ['name', 'version', 'sha256']) || typeof p.parser.name !== 'string'
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.parser.name) || typeof p.parser.version !== 'string'
    || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(p.parser.version) || !hex(p.parser.sha256)) return fail(null, 'provenance');
  if (!Array.isArray(value.orders) || value.orders.length < 1 || value.orders.length > SAVED_ORDERS_MAX) {
    return fail(null, 'order-count');
  }
  const validate = await freshValidator();
  const latest = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const seen = new Map<unknown, number>();
  for (const order of value.orders) {
    const id = isObject(order) ? order.orderId : undefined;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const orders: SavedOrder[] = [], indexes: number[] = [], rejected: SavedRejection[] = [];
  value.orders.forEach((order: unknown, index: number) => {
    try {
      checkOrder(order, index, latest, validate);
      if (seen.get((order as SavedOrder).orderId)! > 1) fail(index, 'order-duplicate');
      orders.push(order as SavedOrder);
      indexes.push(index);
    } catch (error) {
      if (!(error instanceof SavedOrdersRefusal) || error.index !== index) throw error;
      rejected.push({ index, reason: error.reason });
    }
  });
  return { file: { ...(value as unknown as SavedOrdersFile), orders }, indexes, rejected };
}
/** A version-8 UUID from a digest, so the same saved orders are always the same run. */
function runIdFor(d: string): string {
  return `${d.slice(0, 8)}-${d.slice(8, 12)}-8${d.slice(13, 16)}-${'89ab'[parseInt(d[16], 16) & 3]}${d.slice(17, 20)}-${d.slice(20, 32)}`;
}
/** The one synthetic v3 capture of checked saved orders (see the module comment); its run derives from the orders. */
export function savedOrdersCapture(file: SavedOrdersFile): ValidatedCapture {
  const orders = file.orders.map(observation);
  const dates = file.orders.map(o => o.date).sort();
  const pages = file.orders.reduce((n, o) => n + o.pages.length, 0);
  const staging: Staging = {
    format: 'holdr.amazon-staging', version: 3, runId: runIdFor(digest(file)), mode: 'backfill', source: SOURCE,
    window: { from: dates[0], through: dates[dates.length - 1], timeZone: SAVED_TIME_ZONE },
    coverage: {
      orders: { status: 'partial', reason: 'saved-pages', pages: 0, records: orders.length, rejected: 0 },
      payments: { status: 'held', reason: 'saved-pages', pages: 0, records: 0, rejected: 0 },
      details: { status: 'partial', reason: 'saved-pages', pages, records: orders.length, rejected: 0 },
      refunds: { status: 'held', reason: 'saved-pages', pages: 0, records: 0, rejected: 0 },
    },
    resume: { orders: [], payments: null, details: [], restartPayments: false },
    orders, payments: [],
  };
  const fresh = freshSection(file.orders);
  // Version 3 with no diagnostics: every order is a full observation (orderObservationScope), never header-only.
  return { structure: { format: 'holdr.amazon-saved-orders-structure', version: 3 }, staging,
    ...(fresh.lists.length ? { fresh } : {}) };
}
/**
 * One order's gate, value-free: its place in the input and its closed facts. It passes only on its OWN incoming
 * evidence: this capture is the order's display (`displayed`; a conflicting or poorer read is history only and never
 * borrows the old display's match), the order's history does not conflict (`consistent`), the order's total subject is
 * exactly the saved date, total and card (`sameFacts`), and the order's charge is linked `unique` to one card charge:
 * - `total`: its total subject;
 * - `order-part` (a tipped order, TIP_SPLIT_POLICY): where its total found no candidate, its order split part, exactly
 *   the saved date and card and the total minus the saved tip, linked under the split policy. Its tip part is reported
 *   (`tipPart`) and never required: an unlinked tip never holds the order;
 * - `ledger` (savedLedgerGate.ts, design v2, Root's path L): where neither explains it, the order's own completed
 *   single-order Charged ledger observations, each linked under LEDGER_POLICY to its own card row that no other subject
 *   claims, on the saved card and currency, summing exactly to the total minus the saved tip (`ledger` reports the
 *   branch: null when not attempted, else its code). It proves the charge only: `displayed`, `consistent` and
 *   `sameFacts` are still required, and lost and moved stay 0.
 */
export interface SavedGatePart { state: string; reason: string; candidateCount: number }
export interface SavedGateOrder {
  index: number; family: SavedOrder['family']; fresh: boolean; displayed: boolean; consistent: boolean; sameFacts: boolean;
  state: string; reason: string; candidateCount: number; allocationComplete: boolean;
  charge: 'total' | 'order-part' | 'ledger' | 'none';
  /** A tipped order's split parts' match states; null for an order with no tip. */
  orderPart: SavedGatePart | null; tipPart: SavedGatePart | null;
  /** The ledger branch: null when not attempted (the order passed on `total` or `order-part`). */
  ledger: SavedGateLedger | null;
  passed: boolean;
}
export interface SavedGate {
  passed: number; failed: number; linkedRowsLost: number; linkedRowsMoved: number; orders: SavedGateOrder[];
}
const emptyGate = (): SavedGate => ({ passed: 0, failed: 0, linkedRowsLost: 0, linkedRowsMoved: 0, orders: [] });
/** The saved order's positive driver tip in minor units (0: none). */
const savedTip = (o: SavedOrder): number => Math.max(0, o.summary.find(s => s.kind === 'tip')?.money.amountMinor ?? 0);
/** Root's gate after a write of `file` as `captureDigest`: per order (by its place in the input, `indexes`). */
export function savedOrdersGate(db: Database, file: SavedOrdersFile, before: Map<string, string>, captureDigest: string,
  indexes: readonly number[]): SavedGate {
  const after = linkedCardRows(db);
  const subjectOf = (subjectRef: string) => {
    const text = db.prepare('SELECT data_json FROM amazon_subjects WHERE ref=?').pluck().get(subjectRef) as string | undefined;
    return text ? JSON.parse(text) as MatchSubject : null;
  };
  const resultOf = (subjectRef: string) => {
    const text = db.prepare('SELECT data_json FROM amazon_matches WHERE subject_ref=?').pluck().get(subjectRef) as string | undefined;
    return text ? JSON.parse(text) as MatchResult : null;
  };
  const unique = (result: MatchResult | null) => result?.state === 'linked' && result.reason === 'unique'
    && result.evidenceClass === 'unique-total-match';
  const gatePart = (result: MatchResult | null): SavedGatePart => ({ state: result?.state ?? 'none', reason: result?.reason ?? 'none',
    candidateCount: result?.candidateCount ?? 0 });
  let ledgerContext: LedgerGateContext | undefined;
  const ledgerCtx = () => (ledgerContext ??= ledgerGateContext(db, readSubjects(db)));
  const orders = file.orders.map((o, position): SavedGateOrder => {
    const orderRef = opaque('order', o.orderId), ref = opaque('order-total', o.orderId);
    const displayed = db.prepare('SELECT latest_digest FROM amazon_orders WHERE ref=?').pluck().get(orderRef) === captureDigest;
    const consistent = !readOrderHistory(db, orderRef).conflict;
    const subject = subjectOf(ref);
    const facts = (s: MatchSubject | null, amountMinor: number) => !!s && s.date === o.date && s.money.currency === 'USD'
      && s.money.amountMinor === amountMinor && s.method.kind === 'card' && s.method.network === o.payment.network
      && s.method.last4 === o.payment.last4;
    const sameFacts = subject?.provenance === 'order-total' && facts(subject, o.total.amountMinor);
    const result = resultOf(ref);
    let charge: SavedGateOrder['charge'] = unique(result) ? 'total' : 'none';
    let orderPart: SavedGatePart | null = null, tipPart: SavedGatePart | null = null;
    const tip = savedTip(o);
    if (tip > 0) {
      const partRef = splitRef(o.orderId, 'order'), split = subjectOf(partRef), splitResult = resultOf(partRef);
      orderPart = gatePart(splitResult);
      tipPart = gatePart(resultOf(splitRef(o.orderId, 'tip')));
      if (charge === 'none' && result?.state === 'held' && result.reason === 'no-candidate'
        && split?.provenance === 'order-total-split' && split.split?.part === 'order' && split.split.totalRef === ref
        && facts(split, o.total.amountMinor - tip) && unique(splitResult)
        && splitResult?.policyDigest === TIP_SPLIT_POLICY_DIGEST) charge = 'order-part';
    }
    // Neither its total nor its order part explains its charge: only its own ledger charges may (design v2).
    let ledger: SavedGateLedger | null = null;
    if (charge === 'none') {
      ledger = ledgerChargeProof(ledgerCtx(), { orderId: o.orderId, total: o.total, tip, network: o.payment.network,
        last4: o.payment.last4 });
      if (ledger.code === 'passed') charge = 'ledger';
    }
    return { index: indexes[position], family: o.family, fresh: o.fresh !== null, displayed, consistent, sameFacts,
      state: result?.state ?? 'none', reason: result?.reason ?? 'none', candidateCount: result?.candidateCount ?? 0,
      allocationComplete: subject?.allocationComplete ?? false, charge, orderPart, tipPart, ledger,
      passed: displayed && consistent && sameFacts && charge !== 'none' };
  });
  const passed = orders.filter(o => o.passed).length;
  return { passed, failed: orders.length - passed,
    linkedRowsLost: [...before.keys()].filter(row => !after.has(row)).length,
    linkedRowsMoved: [...before].filter(([row, refs]) => after.has(row) && after.get(row) !== refs).length, orders };
}
export const gatePassed = (gate: SavedGate) => gate.failed === 0 && gate.linkedRowsLost === 0 && gate.linkedRowsMoved === 0;
export interface SavedWrite {
  captureDigest: string; receipt: ImportReceipt; freshLists: number; gate: SavedGate;
  /** The orders written: the input's passing orders, with its provenance. */
  file: SavedOrdersFile;
}
export interface SavedOutcome {
  /** Every valid order written together on a savepoint that is always rolled back: who passes on its own evidence. */
  trial: SavedGate;
  /** The orders held by the trial (zero or several charges, a conflict, a borrowed match): never written. */
  held: SavedGateOrder[];
  /** The passing orders' own write, judged again; null when none passed. */
  written: SavedWrite | null;
}
class TrialRollback extends Error {}
function writeSaved(db: Database, file: SavedOrdersFile, inputDigest: string, now: string) {
  const capture = savedOrdersCapture(file);
  const captureDigest = digest(capture);
  const receipt = writeValidatedCapture(db, capture, captureDigest, now);
  const freshLists = capture.fresh?.lists.length ?? 0;
  // A /fopo/ page is an in-store receipt (Whole Foods, Root 03:25Z): its channel is recorded, so it never shows as an
  // Amazon Fresh delivery. Its order row exists now (written above, or kept from an earlier read).
  let channels = 0;
  for (const o of file.orders) {
    if (o.family === 'fopo' && recordOrderChannel(db, opaque('order', o.orderId), 'whole-foods-in-store', captureDigest)) channels++;
  }
  if (receipt.newCaptures) {
    audit(db, 'saved-pages-import', null, undefined, { captureDigest, inputDigest, targetsSha256: file.provenance.targetsSha256,
      indexSha256: file.provenance.indexSha256, parser: file.provenance.parser, orders: file.orders.length, freshLists, channels }, now);
  }
  return { captureDigest, receipt, freshLists };
}
/**
 * The saved orders' import, inside the caller's transaction (Root: per-order isolation; a held order changes nothing):
 * 1. settle the matcher, and record the linked card rows;
 * 2. trial: write every valid order as one capture on a savepoint, judge each order's gate, and always roll back;
 * 3. write only the orders that passed, as their own capture, and judge them again.
 * The caller refuses (and so rolls back everything) when that second gate does not pass whole, which a passing order's
 * own write should never cause; and when no order passed.
 */
export function importSavedOrders(db: Database, parsed: ParsedSavedOrders, inputDigest: string, now: string): SavedOutcome {
  if (!db.inTransaction) throw new HoldrRefusal('amazon saved orders write refused outside a transaction');
  settleAmazon(db, now);
  const before = linkedCardRows(db);
  const { file, indexes } = parsed;
  let trial = emptyGate();
  if (file.orders.length) {
    try {
      db.transaction(() => {
        const { captureDigest } = writeSaved(db, file, inputDigest, now);
        trial = savedOrdersGate(db, file, before, captureDigest, indexes);
        throw new TrialRollback();
      })();
    } catch (error) {
      if (!(error instanceof TrialRollback)) throw error;
    }
  }
  const keep = trial.orders.map(o => o.passed);
  const held = trial.orders.filter(o => !o.passed);
  if (!keep.some(Boolean)) return { trial, held, written: null };
  const passing: SavedOrdersFile = { ...file, orders: file.orders.filter((_o, position) => keep[position]) };
  const write = writeSaved(db, passing, inputDigest, now);
  return { trial, held, written: { ...write, file: passing,
    gate: savedOrdersGate(db, passing, before, write.captureDigest, indexes.filter((_i, position) => keep[position])) } };
}
