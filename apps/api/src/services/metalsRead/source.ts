/**
 * The metals ledger's read side over the database (G3): reads the operator-installed `metals_*` tables (G2) and Holdr's
 * card and checking rows into the plain inputs the read core takes (ledger.ts), and keeps one graph per data version.
 * Read-only: nothing here writes, and every failure leaves only its type and code (value-free).
 *
 * What it reads of the metals tables: the canonical aggregate of each order's active version (never the projections),
 * which orders have a version in conflict (quarantined) and the metals of those versions' lines, every payload's
 * observations, accounts, imports, competitors (every distinct fact-version) and every import that listed each, held
 * records and coverage, the bindings with the facts their drift is judged against, and the owner's live decisions of
 * the two kinds the read applies: product content and bullion answers. Beside them, in the same read transaction, the
 * card cross-check's own reads (cardCheckInputs.ts): posted card credits, the imported accounts and Spending's known
 * card coverage.
 *
 * The data version is SQLite's own: `data_version` (another connection committed), `schema_version` and this
 * connection's `total_changes()`. Any write anywhere makes the next read compute the graph again; reads never do.
 *
 * The tripwire (`metalsCorrectionPresent`): a ledger holding any correction state (a void, a retirement, a correction
 * import; corrections r6, v1) is never read by this build, so no figure is ever computed over one as if it were active.
 * Only a `present` schema is read; the quarantine marker (G2's #327) and every other state are closed. Both are asked
 * inside the graph's own read transaction, so the checks and the figures read one snapshot.
 *
 * Card rows come through `MetalsCardRows`: the API's SqliteStateRepo, or, for the operator's `holdr-metals views-report`
 * on its shared lease's `query_only` handle, `metalsCardRowsReadOnly`, the same reads (the graph's two and the card
 * check's three) with nothing that writes.
 */

import type { Database } from 'better-sqlite3';

import {
  mergeCardCoverage,
  type CardAccount,
  type CardAccountCoverage,
  type CardAccountStatus,
  type CardOwner,
  type CardTransaction,
  type CardTransactionKind,
} from '@finance-tracker/shared';
import {
  METALS,
  metalsChargeParts,
  metalsReceiptCharges,
  type Metal,
  type MetalsAdmissionFacts,
  type MetalsChannel,
  type MetalsChargeParts,
  type MetalsCoverageKind,
  type MetalsDepositEvidence,
  type MetalsHoldReason,
  type MetalsNetwork,
  type MetalsOrder,
  type MetalsReceiptCharge,
  type MetalsSource,
} from '@finance-tracker/shared/metals-ledger';
import type { MetalsAccountRef } from '@finance-tracker/shared/metals-api';

import type { CardCoverageWindowView } from '../cardSync/coverage.js';
import { createCheckingLedgerReader } from '../checking/ledger.js';
import { errorTypeAndCode, toValueFreeDbError } from '../dbErrors.js';
import { metalsSchemaState, type MetalsSchemaState } from '../metals/index.js';
import type { SqliteStateRepo } from '../sqliteStateRepo.js';
import { metalsCardCheckSource, readMetalsCardCheckReads, type MetalsCardCheckSource } from './cardCheckInputs.js';
import { buildMetalsLedgerGraph, type MetalsLedgerGraph, type MetalsLedgerInputs } from './ledger.js';

const EVERY_DAY = { from: '1900-01-01', to: '2999-12-31' } as const;

/** SQLite's data version as seen by this connection: changes when anything is written, here or by another connection. */
export function metalsDataVersion(db: Database): string {
  const dataVersion = db.pragma('data_version', { simple: true });
  const schemaVersion = db.pragma('schema_version', { simple: true });
  const changes = db.prepare('SELECT total_changes()').pluck().get();
  return `${String(dataVersion)}:${String(schemaVersion)}:${String(changes)}`;
}

/**
 * The correction states of slice 2's schema (corrections design r6), each written only by a v1 command (void-import,
 * its retirement, a correction import) that this build doesn't read. One clause per state:
 * - an account retired;
 * - an import voided;
 * - a void's retirement or collateral authorization;
 * - an import correcting another;
 * - a version a void voided, one it renewed, or a copy it reinstated;
 * - an observation of a renewal.
 */
export const METALS_CORRECTION_STATES: readonly string[] = Object.freeze([
  'SELECT 1 FROM metals_accounts WHERE retired_by_import IS NOT NULL',
  `SELECT 1 FROM metals_imports WHERE voided_by_go IS NOT NULL OR voided_at IS NOT NULL OR void_reason IS NOT NULL
    OR voided_under_marker IS NOT NULL OR voided_under_reason IS NOT NULL`,
  'SELECT 1 FROM metals_imports WHERE retire_account_id IS NOT NULL OR voided_for_import IS NOT NULL',
  'SELECT 1 FROM metals_imports WHERE corrects_import IS NOT NULL',
  `SELECT 1 FROM metals_order_versions WHERE resolution = 'voided'`,
  `SELECT 1 FROM metals_order_versions WHERE reason = 'renewed'`,
  `SELECT 1 FROM metals_order_versions WHERE reason = 'reinstated' OR reinstates_version IS NOT NULL OR reinstated_by_go IS NOT NULL`,
  `SELECT 1 FROM metals_observations WHERE outcome = 'renewed'`,
]);

/**
 * The tripwire (the Gold lead's A0 ruling): whether the ledger holds any correction state. This build reads no void and
 * no retirement (v1), so with any present nothing is read, never an active figure. Asks only an installed ledger.
 */
export function metalsCorrectionPresent(db: Database): boolean {
  try {
    return db.prepare(`SELECT EXISTS (${METALS_CORRECTION_STATES.join(') OR EXISTS (')})`).pluck().get() === 1;
  } catch (error) {
    throw toValueFreeDbError('read the metals ledger', error);
  }
}

/** The tripwire's refusal: the snapshot a read or a write reads holds a correction this build can't read. */
export class MetalsCorrectionUnsupported extends Error {
  constructor() {
    super('correction-unsupported');
    this.name = 'MetalsCorrectionUnsupported';
  }
}

/**
 * The schema's state, seen inside a read snapshot or a write's transaction, isn't `present`: a quarantine marker
 * (corrections r6 §1), another shape, or no tables. Every state but `present` is closed, so nothing is read or written.
 */
export class MetalsSchemaClosed extends Error {
  constructor() {
    super('schema-closed');
    this.name = 'MetalsSchemaClosed';
  }
}

/** Why a snapshot is never read: its schema isn't exactly this build's, or it holds a correction (the tripwire). */
type MetalsSnapshotRefusal = 'schema-closed' | 'correction-unsupported';

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TypeError(`a stored ${what} is not JSON`);
  }
}

/**
 * The metals of a conflicting version's lines, each once (null: unknown metal). The read side reads nothing else of a
 * conflicting version, and fails closed on it (H6): text that isn't JSON, or isn't the order it is filed under with its
 * lines, is all unknown metal, and so is a line naming no metal this build knows.
 */
export function metalsConflictVersionMetals(json: string, orderKey: string): Array<Metal | null> {
  let order: unknown;
  try {
    order = JSON.parse(json);
  } catch {
    return [null];
  }
  const lines = order !== null && typeof order === 'object' && (order as { key?: unknown }).key === orderKey ? (order as { lines?: unknown }).lines : null;
  if (!Array.isArray(lines) || lines.length === 0) return [null];
  const metals: Array<Metal | null> = [];
  for (const line of lines) {
    const named = line !== null && typeof line === 'object' ? (line as { metal?: unknown }).metal : undefined;
    const metal = typeof named === 'string' && (METALS as readonly string[]).includes(named) ? named as Metal : null;
    if (!metals.includes(metal)) metals.push(metal);
  }
  return metals;
}

/**
 * What the read takes of Holdr's card rows, with only the fields it reads: for the graph, every card account and the
 * posted purchases; for the card check (cardCheckInputs.ts), the posted refunds, each account's declared import coverage
 * and the committed card-sync windows. The API reads them through SqliteStateRepo; the operator's views report through
 * `metalsCardRowsReadOnly`.
 */
export interface MetalsCardRows {
  listCardAccounts(): ReadonlyArray<Pick<CardAccount, 'id' | 'issuer' | 'owner' | 'nickname' | 'last4' | 'last5' | 'status'>>;
  listCardTransactionsMatching(query: { statuses: readonly ['posted']; kinds: readonly ['purchase'] | readonly ['refund'] }): ReadonlyArray<Pick<CardTransaction,
    'id' | 'cardAccountId' | 'transactionDate' | 'amountMinor' | 'kind' | 'currency' | 'merchant' | 'description'>>;
  listCardCoverage(): ReadonlyArray<Pick<CardAccountCoverage, 'cardAccountId' | 'ranges'>>;
  listCardCoverageWindows(filter: { ledgerStates: readonly ['committed'] }): ReadonlyArray<Pick<CardCoverageWindowView,
    'cardAccountId' | 'verifiedCompleteness' | 'requested'>>;
}

/** The read-only card reader's one refusal: a query the metals read never makes. */
const READ_ONLY_REFUSAL = 'the read-only card reader reads only what the metals read asks';

/**
 * The card rows the read takes, on any handle, a `query_only` one included: SqliteStateRepo's own statements for its
 * reads (`listCardAccounts`; `listCardTransactionsMatching` for posted purchases or posted refunds; `listCardCoverage`'s
 * declared ranges, merged per account; `listCardCoverageWindows` for committed windows), each mapped as the repository
 * maps it, a NULL read as absent. Nothing here writes, and no SqliteStateRepo is opened (opening one migrates the
 * database). Any other query is refused.
 */
export function metalsCardRowsReadOnly(db: Database): MetalsCardRows {
  const listCardAccounts = () => (db.prepare('SELECT id, issuer, owner, nickname, last4, last5, status FROM card_accounts ORDER BY created_at, rowid')
    .all() as Array<{ id: string; issuer: string; owner: CardOwner; nickname: string | null; last4: string | null; last5: string | null;
      status: CardAccountStatus }>)
    .map((row) => ({ id: row.id, issuer: row.issuer, owner: row.owner, nickname: row.nickname ?? undefined, last4: row.last4 ?? undefined,
      last5: row.last5 ?? undefined, status: row.status }));
  return {
    listCardAccounts,
    listCardTransactionsMatching: (query) => {
      const kind = query.kinds.length === 1 ? query.kinds[0] : null;
      if (query.statuses.length !== 1 || query.statuses[0] !== 'posted' || (kind !== 'purchase' && kind !== 'refund')) {
        throw new TypeError(READ_ONLY_REFUSAL);
      }
      return (db.prepare(`SELECT id, card_account_id AS cardAccountId, transaction_date AS transactionDate, amount_minor AS amountMinor, kind, currency,
          merchant, description FROM card_transactions WHERE status IN ('posted') AND kind IN (?) ORDER BY transaction_date, rowid`)
        .safeIntegers(false).all(kind) as Array<{ id: string; cardAccountId: string; transactionDate: string; amountMinor: number; kind: CardTransactionKind;
          currency: string; merchant: string | null; description: string }>)
        .map((row) => ({ ...row, merchant: row.merchant ?? undefined }));
    },
    listCardCoverage: () => {
      const batches = db.prepare(`SELECT card_account_id AS cardAccountId, coverage_start AS coverageStart, coverage_end AS coverageEnd
        FROM card_import_batches ORDER BY imported_at, rowid`).all() as Array<{ cardAccountId: string; coverageStart: string | null; coverageEnd: string | null }>;
      return listCardAccounts().map((account) => ({
        cardAccountId: account.id,
        ranges: mergeCardCoverage(batches.flatMap((batch) => (batch.cardAccountId === account.id && batch.coverageStart !== null
          && batch.coverageEnd !== null ? [{ start: batch.coverageStart, end: batch.coverageEnd }] : []))),
      }));
    },
    listCardCoverageWindows: (filter) => {
      if (Object.keys(filter).length !== 1 || filter.ledgerStates.length !== 1 || filter.ledgerStates[0] !== 'committed') {
        throw new TypeError(READ_ONLY_REFUSAL);
      }
      return (db.prepare(`SELECT card_account_id AS cardAccountId, verified_completeness AS verifiedCompleteness, requested_start AS requestedStart,
          requested_end AS requestedEnd, requested_basis AS requestedBasis FROM card_coverage_windows WHERE ledger_state IN ('committed')
          ORDER BY card_account_id, card_scope_id, status, coalesce(observed_start, requested_start), recorded_at, id`)
        .all() as Array<{ cardAccountId: string; verifiedCompleteness: CardCoverageWindowView['verifiedCompleteness']; requestedStart: string | null;
          requestedEnd: string | null; requestedBasis: string | null }>)
        .map((row) => ({
          cardAccountId: row.cardAccountId, verifiedCompleteness: row.verifiedCompleteness,
          requested: row.requestedStart === null ? null : { start: row.requestedStart, end: row.requestedEnd!, basis: row.requestedBasis! },
        }));
    },
  };
}

/**
 * Reads the inputs of the read core. With `links: false` (an owner preview inside its write transaction) card and
 * checking rows are left out: content and holdings don't read them.
 */
export function readMetalsLedgerInputs(
  db: Database,
  repo: MetalsCardRows,
  options: { links: boolean },
): MetalsLedgerInputs {
  try {
    const versions = db.prepare(`SELECT order_key AS orderKey, digest, canonical_json AS json FROM metals_order_versions
      WHERE state = 'active' ORDER BY order_key`).all() as Array<{ orderKey: string; digest: string; json: string }>;
    const readVersion = (row: { orderKey: string; json: string }): MetalsOrder => {
      const order = parseJson<MetalsOrder>(row.json, 'order version');
      if (order === null || typeof order !== 'object' || order.key !== row.orderKey || !Array.isArray(order.lines)) {
        throw new TypeError('a stored order version is not the order it is filed under');
      }
      return order;
    };
    // Each conflicting version's line metals (null: unknown metal): fail-closed, an order is any page's whose metal one
    // of its versions has a line of, and a version this read can't take as its order, or a line naming no metal it
    // knows, is of unknown metal (H6).
    const conflictMetals = new Map<string, Array<Metal | null>>();
    for (const row of db.prepare(`SELECT order_key AS orderKey, canonical_json AS json FROM metals_order_versions WHERE state = 'conflict'
      ORDER BY order_key, version`).all() as Array<{ orderKey: string; json: string }>) {
      const metals = conflictMetals.get(row.orderKey) ?? [];
      for (const metal of metalsConflictVersionMetals(row.json, row.orderKey)) if (!metals.includes(metal)) metals.push(metal);
      conflictMetals.set(row.orderKey, metals);
    }
    const orders = versions.map((row) => ({
      order: readVersion(row), digest: row.digest, quarantined: conflictMetals.has(row.orderKey), conflictMetals: conflictMetals.get(row.orderKey) ?? [],
    }));
    const observations = db.prepare(`SELECT import_id AS importId, account_id AS accountId, order_key AS orderKey FROM metals_observations`)
      .all() as MetalsLedgerInputs['observations'];
    const accounts = db.prepare(`SELECT account_id AS accountId, source, label FROM metals_accounts ORDER BY account_id`)
      .all() as MetalsAccountRef[];
    const imports = db.prepare(`SELECT import_id AS importId, import_seq AS importSeq, source, account_id AS accountId, captured_at AS capturedAt,
      imported_at AS importedAt, capture_schema AS captureSchema, converter_version AS converterVersion FROM metals_imports ORDER BY import_seq`)
      .all() as MetalsLedgerInputs['imports'];
    const competitorRows = db.prepare(`SELECT order_key AS orderKey, channel, order_date AS date, admission_json AS admission,
      facts_digest AS factsDigest, MIN(import_id) AS importId FROM metals_competitors GROUP BY order_key, facts_digest
      ORDER BY order_key, facts_digest`).all() as Array<{ orderKey: string; channel: MetalsChannel; date: string; admission: string; factsDigest: string; importId: string }>;
    const competitors = competitorRows.map((row) => ({ ...row, admission: parseJson<MetalsAdmissionFacts>(row.admission, 'competitor') }));
    // Every import that listed a competitor, unchanged re-reads included (D-G2-2): a later one closes an earlier hold.
    const competitorObservations = db.prepare(`SELECT import_id AS importId, order_key AS orderKey, fact_digest AS factsDigest
      FROM metals_competitor_observations ORDER BY import_id, order_key`).all() as MetalsLedgerInputs['competitorObservations'];
    const holds = db.prepare(`SELECT import_id AS importId, seq, source, account_id AS accountId, record_key AS key, channel,
      record_date AS date, reason, check_code AS "check" FROM metals_holds ORDER BY import_id, seq`).all() as Array<{
      importId: string; seq: number; source: MetalsSource; accountId: string; key: string | null; channel: MetalsChannel; date: string | null;
      reason: MetalsHoldReason; check: string;
    }>;
    const coverage = (db.prepare(`SELECT import_id AS importId, source, account_id AS accountId, kind, date_from AS "from", date_to AS "to",
      stated, seen, complete FROM metals_coverage ORDER BY import_id, seq`).all() as Array<{
      importId: string; source: MetalsSource; accountId: string; kind: MetalsCoverageKind; from: string; to: string; stated: number | null; seen: number;
      complete: number;
    }>).map((row) => ({ ...row, complete: row.complete === 1 }));
    const bindings = (db.prepare(`SELECT kind, source, network, last4, account_id AS accountId, state, account_status AS accountStatus,
      account_owner AS accountOwner, peer_account_ids AS peers FROM metals_bindings ORDER BY binding_id`).all() as Array<{
      kind: 'card' | 'checking'; source: MetalsSource; network: MetalsNetwork | null; last4: string; accountId: string; state: 'active' | 'revoked';
      accountStatus: 'active' | 'closed'; accountOwner: string | null; peers: string;
    }>).map(({ peers, ...row }) => {
      const ids = parseJson<unknown>(peers, 'binding');
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new TypeError('a stored binding names its peers wrongly');
      return { ...row, peerAccountIds: ids as string[] };
    });
    const decisions = db.prepare(`SELECT decision_id AS id, scope, product_ref AS productRef, fingerprint, lot_key AS lotKey,
      evidence_digest AS evidenceDigest, metal, troy_oz_per_unit AS troyOzPerUnit, decided_at AS decidedAt FROM metals_owner_decisions
      WHERE kind = 'product-content' AND revoked_at IS NULL AND scope IN ('product', 'lot') ORDER BY decided_at, decision_id`)
      .all() as Array<{ id: string; scope: 'product' | 'lot'; productRef: string | null; fingerprint: string | null; lotKey: string | null;
        evidenceDigest: string | null; metal: Metal | null; troyOzPerUnit: string; decidedAt: string }>;
    // The owner's live answers for the lines the title guard flagged (G3-dec): the one matcher reads them all.
    const bullionDecisions = db.prepare(`SELECT decision_id AS id, scope, product_ref AS productRef, fingerprint, lot_key AS lotKey,
      evidence_digest AS evidenceDigest, answer, decided_at AS decidedAt FROM metals_owner_decisions
      WHERE kind = 'bullion' AND revoked_at IS NULL AND scope IN ('product', 'lot') ORDER BY decided_at, decision_id`)
      .all() as MetalsLedgerInputs['bullionDecisions'];

    const inputs: MetalsLedgerInputs = {
      orders, observations, accounts, imports, competitors, competitorObservations, holds, coverage, bindings, decisions, bullionDecisions,
      cardAccounts: [], cardRows: [], checking: { installed: false, accounts: [], rows: [], coverage: [] },
    };
    if (!options.links) return inputs;

    inputs.cardAccounts = repo.listCardAccounts().map((account) => ({
      id: account.id, issuer: account.issuer, owner: account.owner, nickname: account.nickname ?? null, last4: account.last4 ?? null,
      last5: account.last5 ?? null, status: account.status,
    }));
    inputs.cardRows = repo.listCardTransactionsMatching({ statuses: ['posted'], kinds: ['purchase'] }).map((row) => ({
      id: row.id, accountId: row.cardAccountId, date: row.transactionDate, amountMinor: row.amountMinor, kind: row.kind, currency: row.currency,
      merchant: row.merchant ?? null, description: row.description,
    }));
    const checking = createCheckingLedgerReader(db);
    if (checking.installed()) {
      inputs.checking = {
        installed: true,
        accounts: checking.listAccounts().map((account) => ({ id: account.id, label: account.label, last4: account.last4, status: account.status })),
        rows: checking.listRows(EVERY_DAY).map((row) => ({
          id: row.id, accountId: row.checkingAccountId, date: row.date, amountMinor: row.amountMinor, currency: row.currency, description: row.description,
        })),
        coverage: checking.coverage().flatMap((entry) => entry.ranges.map((range) => ({ accountId: entry.checkingAccountId, from: range.start, to: range.end }))),
      };
    }
    return inputs;
  } catch (error) {
    throw toValueFreeDbError('read the metals ledger', error);
  }
}

/**
 * One read snapshot: the graph, and what the card cross-check computes from (PR-B; design v3.2 §8.3), read in the
 * graph's own read transaction. When only the check's own reads fail, the graph still serves, and `check` says why the
 * check is unavailable (the error's type and code only).
 */
export interface MetalsLedgerSnapshot {
  /** The data version both were read under. */
  version: string;
  graph: MetalsLedgerGraph;
  check: MetalsCardCheckSource | { failed: string };
}

/**
 * The metals ledger as the routes and the follow-ups (G5's receipt charges, P1) read it: the schema's state, and the
 * graph computed once per data version over the whole ledger, with the card check's own reads beside it. The operator's
 * views report builds one over its own read-only handle and card reader (`metalsCardRowsReadOnly`).
 */
export class MetalsReadModel {
  /** The snapshot of one data version, or why that version's snapshot is never read. */
  private cached: { version: string; read: MetalsLedgerSnapshot | MetalsSnapshotRefusal } | null = null;

  constructor(private readonly repo: MetalsCardRows & Pick<SqliteStateRepo, 'internalGetDb'>) {}

  get db(): Database {
    return this.repo.internalGetDb();
  }

  /** The card rows' reader, for a write that recomputes its preview inside its transaction. */
  get cardRepo(): MetalsCardRows {
    return this.repo;
  }

  /**
   * `present` for exactly G2's tables, `absent` without any, and anything else (another shape; with G2's #327 the
   * quarantine marker, `quarantined`) closed: only `present` is ever read.
   */
  schemaState(): MetalsSchemaState {
    return metalsSchemaState(this.db);
  }

  /**
   * The graph for the current data version. A snapshot whose schema isn't `present` gives `MetalsSchemaClosed`, and one
   * holding a correction this build can't read gives `MetalsCorrectionUnsupported` (the tripwire): never a graph.
   */
  graph(): MetalsLedgerGraph {
    return this.ledgerSnapshot().graph;
  }

  /** The current data version's snapshot: the graph and the card check's source, refused exactly as `graph()` is. */
  ledgerSnapshot(): MetalsLedgerSnapshot {
    const read = this.snapshot();
    if (read === 'schema-closed') throw new MetalsSchemaClosed();
    if (read === 'correction-unsupported') throw new MetalsCorrectionUnsupported();
    return read;
  }

  /**
   * The snapshot, or why it is never read, computed once per data version. The schema's state and the tripwire are
   * asked inside the graph's own read transaction, schema first, so the checks and the figures read one snapshot: a
   * marker or a correction another connection commits after a caller's checks is found there, and never read as
   * active. The card check's own reads are read in the same transaction; their failure leaves the graph as it is.
   */
  private snapshot(): MetalsLedgerSnapshot | MetalsSnapshotRefusal {
    const db = this.db;
    const version = metalsDataVersion(db);
    if (this.cached && this.cached.version === version) return this.cached.read;
    const read = db.transaction((): MetalsLedgerSnapshot | MetalsSnapshotRefusal => {
      if (metalsSchemaState(db) !== 'present') return 'schema-closed';
      if (metalsCorrectionPresent(db)) return 'correction-unsupported';
      const inputs = readMetalsLedgerInputs(db, this.repo, { links: true });
      const graph = buildMetalsLedgerGraph(inputs);
      let check: MetalsLedgerSnapshot['check'];
      try {
        check = metalsCardCheckSource(inputs, readMetalsCardCheckReads(db, this.repo));
      } catch (error) {
        check = { failed: errorTypeAndCode(error) };
      }
      return { version, graph, check };
    })();
    this.cached = { version, read };
    return read;
  }

  /** The graph when its snapshot can be read (exactly this build's tables, and no correction), else null. */
  private readable(): MetalsLedgerGraph | null {
    const read = this.snapshot();
    return typeof read === 'string' ? null : read.graph;
  }

  /** Receipt-confirmed charges (§10): proof-linked card rows of all-metal orders; none without the tables, or over a correction. */
  receiptCharges(): MetalsReceiptCharge[] {
    const graph = this.readable();
    return graph === null ? [] : metalsReceiptCharges(graph.cardGraph, graph.chargeOrders);
  }

  /** A proof-linked card row's parts (§10, P2's read contract), or why it has none. */
  chargeParts(rowId: string): MetalsChargeParts {
    const graph = this.readable();
    return graph === null ? { provable: false, reason: 'not-linked' } : metalsChargeParts(rowId, graph.cardGraph, graph.chargeOrders);
  }

  /** Checking credits proved to be a sale's payout: asset-sale proceeds, never income (§10); none without the tables, or over a correction. */
  depositEvidence(): MetalsDepositEvidence[] {
    const graph = this.readable();
    return graph === null ? [] : [...graph.depositEvidence];
  }
}
