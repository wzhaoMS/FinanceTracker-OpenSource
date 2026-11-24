/**
 * The card cross-check's inputs (design v3.2 §2.1, §3.1–§3.3, §6.3, §8.1, §8.3; PR-B, G3): what the capture check and
 * the served coverage proof read besides the graph, and how the graph's own readings map onto their inputs. Read in
 * the graph's own read transaction (source.ts), so the graph, the check and the proof read one snapshot. Read-only:
 * nothing here writes, and a failure leaves only its type and code.
 *
 * - Card credits (§2.1): posted `refund` rows, in their own input. The graph's card rows stay purchases only, since only
 *   purchase consumers read them. Posted leaves out every removed row: a dismissed, merged or removed row is stored
 *   `removed`.
 * - Imported accounts: every source account, and whether a later import retired it (`retired_by_import`). A served
 *   snapshot never holds one, since the tripwire refuses any retirement (source.ts).
 * - Card coverage (C7): per card account Holdr holds, any status, the days Spending knows every row of
 *   (`cardCoverageEvidence`, routes/cardSpendingOverview.ts): the ranges its imports declared, and the committed
 *   card-sync windows Holdr verified complete on the transaction-date basis. Never the days its rows happen to span. A
 *   service doesn't import a route, so the same filter is read here; a test holds the two equal.
 */

import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { mergeCardCoverage, toLetterHex, type CardAccountCoverage, type CardCoverageRange } from '@finance-tracker/shared';
import type {
  Metal,
  MetalsCaptureCardAccount,
  MetalsCaptureCardRow,
  MetalsCaptureHold,
  MetalsCaptureOrder,
  MetalsCardBinding,
  MetalsSource,
  MetalsStatedCoverage,
} from '@finance-tracker/shared/metals-ledger';

import type { CardCoverageWindowView } from '../cardSync/coverage.js';
import { toValueFreeDbError } from '../dbErrors.js';
import { metalsCardBindings, type MetalsCardRowInput, type MetalsLedgerGraph, type MetalsLedgerInputs } from './ledger.js';
import type { MetalsCardRows } from './source.js';
import type { MetalsViews } from './views.js';

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** An imported source account (`metals_accounts`), with whether a later import retired it. */
export interface MetalsImportedAccount {
  accountId: string;
  source: MetalsSource;
  label: string;
  retired: boolean;
}

/** A card account's known card coverage: inclusive days, merged (adjacent days join), ascending and disjoint. */
export interface MetalsCardCoverage {
  accountId: string;
  covered: Array<{ from: string; to: string }>;
}

/** What the card check reads besides the graph's inputs, in the graph's own read transaction. */
export interface MetalsCardCheckReads {
  /** Posted card credits (`refund` rows), amounts as stored. */
  credits: MetalsCardRowInput[];
  importedAccounts: MetalsImportedAccount[];
  /** Every card account with known coverage, by id. */
  cardCoverage: MetalsCardCoverage[];
}

/**
 * Spending's known card coverage per card account, with `cardCoverageEvidence`'s filter: every account's declared import
 * ranges, and each committed card-sync window Holdr verified complete over a transaction-date request (the caller reads
 * committed windows only). Merged per account, by account id.
 */
export function metalsCardCoverage(
  declared: ReadonlyArray<Pick<CardAccountCoverage, 'cardAccountId' | 'ranges'>>,
  windows: ReadonlyArray<Pick<CardCoverageWindowView, 'cardAccountId' | 'verifiedCompleteness' | 'requested'>>,
): MetalsCardCoverage[] {
  const ranges = new Map<string, CardCoverageRange[]>();
  const add = (accountId: string, more: readonly CardCoverageRange[]) => ranges.set(accountId, [...(ranges.get(accountId) ?? []), ...more]);
  for (const card of declared) add(card.cardAccountId, card.ranges);
  for (const window of windows) {
    if (window.verifiedCompleteness === 'complete' && window.requested !== null && window.requested.basis === 'transaction') {
      add(window.cardAccountId, [{ start: window.requested.start, end: window.requested.end }]);
    }
  }
  return [...ranges.entries()].sort(([a], [b]) => compareText(a, b))
    .map(([accountId, list]) => ({ accountId, covered: mergeCardCoverage(list).map((range) => ({ from: range.start, to: range.end })) }));
}

/**
 * Reads the card check's own inputs. Called inside the graph's read transaction, through the read's card reader
 * (`MetalsCardRows`: the API's SqliteStateRepo, or the views report's read-only reader).
 */
export function readMetalsCardCheckReads(
  db: Database,
  repo: Pick<MetalsCardRows, 'listCardTransactionsMatching' | 'listCardCoverage' | 'listCardCoverageWindows'>,
): MetalsCardCheckReads {
  try {
    const credits = repo.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['refund'] }).map((row) => ({
      id: row.id, accountId: row.cardAccountId, date: row.transactionDate, amountMinor: row.amountMinor, kind: row.kind, currency: row.currency,
      merchant: row.merchant ?? null, description: row.description,
    }));
    const importedAccounts = (db.prepare(`SELECT account_id AS accountId, source, label, retired_by_import IS NOT NULL AS retired
      FROM metals_accounts ORDER BY account_id`).all() as Array<Omit<MetalsImportedAccount, 'retired'> & { retired: number }>)
      .map((row) => ({ ...row, retired: row.retired === 1 }));
    const cardCoverage = metalsCardCoverage(repo.listCardCoverage(), repo.listCardCoverageWindows({ ledgerStates: ['committed'] }));
    return { credits, importedAccounts, cardCoverage };
  } catch (error) {
    throw toValueFreeDbError('read the card check', error);
  }
}

/** The owner-answer gate (§7.1): closed in this build, which has no key to open it. */
export const METALS_OWNER_ANSWERS_GATE = 'closed' as const;

/**
 * The snapshot token (§8.3): opaque and value-free, 64 letters a–p, over every input of one card check and coverage
 * proof: the data version (SQLite's, which every metals, card and coverage write moves), the capture's alias policy,
 * the owner-answer gate and the New York day. The overview's proof, the card check and the roster preview carry it, so
 * a page that combines them can require them equal.
 */
export function metalsReadSnapshot(input: { dataVersion: string; aliasPolicy: string; day: string }): string {
  const preimage = ['holdr.metals-read-snapshot', 1, input.dataVersion, input.aliasPolicy, `owner-answers:${METALS_OWNER_ANSWERS_GATE}`, input.day];
  return toLetterHex(createHash('sha256').update(JSON.stringify(preimage), 'utf8').digest());
}

/** The admitted records as of a day (§6.3), as the coverage proof reads them. */
export interface MetalsProofRecords {
  buys: Array<{ source: MetalsSource; metal: Metal | null; date: string }>;
  sales: Array<{ source: MetalsSource; metal: Metal | null; agreedDay: string; included: boolean }>;
  metalUnknown: { lots: number; saleLines: number };
}

/**
 * The admitted records as of `asOf`: the ledger's lines that count (`graph.lines`; an order held for metals is in no
 * figure, and the measures' `source-held` carries it), each with its line's metal, buys by order date and sales by
 * agreed day, on or before `asOf`. A sale is `included` exactly when the prices-off result counts it: it is in the
 * assignment as of `asOf`, which keeps the sales neither cancelled nor agreed after it (`metalsAssignment`), the set
 * `metalsProfitOnSales` reads. `metalUnknown` is the overview's: that assignment's lots and sale lines of unknown metal.
 */
export function metalsProofRecords(views: MetalsViews, asOf: string): MetalsProofRecords {
  const assignment = views.assignment(asOf);
  const included = new Set(assignment.sales.map((line) => line.key));
  const records: MetalsProofRecords = {
    buys: [], sales: [], metalUnknown: { lots: assignment.metalUnknown.lots.length, saleLines: assignment.metalUnknown.sales.length },
  };
  for (const entry of views.graph.lines) {
    const date = entry.order.order.date;
    if (date > asOf) continue;
    if (entry.side === 'buy') records.buys.push({ source: entry.order.source, metal: entry.line.metal, date });
    else records.sales.push({ source: entry.order.source, metal: entry.line.metal, agreedDay: date, included: included.has(entry.key) });
  }
  return records;
}

/**
 * The ledger's orders as capture occurrences (§3.1, §3.2): every buy order with card funding facts, on its active
 * version, metal or not, `active` unless quarantined. An order held for metals is passed as any order, so it takes its
 * role from its admission alone (C2 b): a subject, or an aggregate barrier up to its gross total. It is never a
 * barrier at any amount: only open held records are (`metalsCaptureHolds`).
 */
export function metalsCaptureLedgerOrders(graph: MetalsLedgerGraph): MetalsCaptureOrder[] {
  return [...graph.orders.values()].filter((entry) => entry.order.side === 'buy' && entry.order.admission !== null).map((entry) => ({
    orderKey: entry.order.key, source: entry.source, channel: entry.order.channel, date: entry.order.date, admission: entry.order.admission!,
    active: !entry.quarantined,
  }));
}

/** Every listing of a competitor with its import's causal sequence: what its latest fact-version is chosen by. */
export function metalsCompetitorListings(inputs: Pick<MetalsLedgerInputs, 'imports' | 'competitorObservations'>):
  Array<{ orderKey: string; factsDigest: string; importSeq: number }> {
  const importSeq = new Map(inputs.imports.map((entry) => [entry.importId, entry.importSeq]));
  return inputs.competitorObservations.map((listing) => ({
    orderKey: listing.orderKey, factsDigest: listing.factsDigest, importSeq: importSeq.get(listing.importId) ?? Number.MAX_SAFE_INTEGER,
  }));
}

/** What one snapshot's card check is computed from besides the graph, taken from the graph's own inputs and reads. */
export interface MetalsCardCheckSource {
  reads: MetalsCardCheckReads;
  /** Every distinct fact-version of each competitor (`metals_competitors`), as the graph's inputs hold them. */
  competitors: MetalsLedgerInputs['competitors'];
  /**
   * Every import that listed a competitor (`metals_competitor_observations`), with its causal sequence: the capture
   * check takes each competitor at the fact-version its latest listing names (C2 a). An import this read doesn't know
   * sorts last, as in the graph.
   */
  listings: Array<{ orderKey: string; factsDigest: string; importSeq: number }>;
  /** The card bindings card links read (`metalsCardBindings`): one binding rule for links and capture. */
  bindings: MetalsCardBinding[];
}

export function metalsCardCheckSource(inputs: MetalsLedgerInputs, reads: MetalsCardCheckReads): MetalsCardCheckSource {
  return {
    reads, competitors: inputs.competitors, listings: metalsCompetitorListings(inputs), bindings: metalsCardBindings(inputs.bindings, inputs.cardAccounts),
  };
}

/** The open held records (§3.2): barriers dated in their interval, or at any date when undated. */
export function metalsCaptureHolds(graph: MetalsLedgerGraph): MetalsCaptureHold[] {
  return graph.openHolds.map((hold) => ({ source: hold.source, channel: hold.channel, date: hold.date }));
}

/** The graph's posted purchases and the posted credits read beside them, in that order: every row read is posted, so usable. */
export function metalsCaptureRows(graph: MetalsLedgerGraph, reads: Pick<MetalsCardCheckReads, 'credits'>): MetalsCaptureCardRow[] {
  const row = (input: MetalsCardRowInput, kind: 'purchase' | 'credit'): MetalsCaptureCardRow => ({
    id: input.id, accountId: input.accountId, date: input.date, amountMinor: input.amountMinor, kind, currency: input.currency, usable: true,
    merchant: input.merchant, description: input.description,
  });
  return [...[...graph.cardRows.values()].map((input) => row(input, 'purchase')), ...reads.credits.map((input) => row(input, 'credit'))];
}

/** Every card account Holdr holds, any status, with its issuer and last 4 (a last 5 always ends with it). */
export function metalsCaptureAccounts(graph: MetalsLedgerGraph): MetalsCaptureCardAccount[] {
  return [...graph.cardAccounts.values()].map((account) => ({ id: account.id, issuer: account.issuer, last4: account.last4, status: account.status }));
}

/**
 * The coverage the measures count (H7: only what an import this read knows states, as `knownCoverage` reads it), each
 * entry with its import's capture schema and converter version.
 */
export function metalsStatedCoverage(graph: MetalsLedgerGraph): MetalsStatedCoverage[] {
  const imports = new Map(graph.imports.map((entry) => [entry.importId, entry]));
  return graph.coverage.flatMap((entry) => {
    const stated = imports.get(entry.importId);
    return stated === undefined ? [] : [{
      accountId: entry.accountId, source: entry.source, kind: entry.kind, from: entry.from, to: entry.to, complete: entry.complete,
      captureSchema: stated.captureSchema, converterVersion: stated.converterVersion,
    }];
  });
}

/** Per card account Holdr holds, any status, its known card coverage (none: no day), by account id (C7). */
export function metalsCardHistory(graph: MetalsLedgerGraph, reads: Pick<MetalsCardCheckReads, 'cardCoverage'>): MetalsCardCoverage[] {
  const known = new Map(reads.cardCoverage.map((entry) => [entry.accountId, entry.covered]));
  return [...graph.cardAccounts.keys()].sort(compareText).map((accountId) => ({ accountId, covered: known.get(accountId) ?? [] }));
}
