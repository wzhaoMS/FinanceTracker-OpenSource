import type { Database as DB, Statement } from 'better-sqlite3';

import { CARD_SYNC_QUERIES, type CardSyncQueryName } from './cardSyncSchemaSql.js';

/**
 * The 22 named statements of card-sync schema v15 (E1b design §4.9.2, §5.2,
 * §5.3.1, §5.5, §5.6, §5.7.1, §5.9), prepared once per connection from the
 * design's own text (cardSyncSchemaSql.ts) and typed by their named
 * parameters and result columns. The repository's card-sync methods (later
 * slices) call them inside their own IMMEDIATE transactions and behind the
 * value-free boundary; nothing here opens a transaction or catches an error.
 *
 * §5.3.1's shared statements and the paths that must use them, in this order,
 * so a revoked or expired grant always gives up its auto-sync consent in the
 * same UPDATE (`ck_dscope_consent_shape` refuses a status-only revoke):
 *
 * | Path | Statements |
 * |---|---|
 * | natural expiry (retention phase 2) | device `expired`; `revoke-grants-of-device`; the device's own prepared plans cancelled |
 * | revokeCardSyncDevice (owner, password reset) and the rotation inside approveCardSyncPairing | device `revoked`; `revoke-grants-of-device`; `quarantine-sets-of-device`; `cancel-plans-of-device`; `close-pairing-of-device` |
 * | retireCardSourceBinding | `revoke-grants-of-binding`; the binding's open sets blocked and their plans cancelled |
 * | confirmCardSourceBinding | `withdraw-consent-of-binding`; `revoke-grant` on each re-granted device's old row |
 * | regrantCardSyncDevice | `revoke-grant` on each stale row before the new grant |
 * | setCardSyncAutoSync({ enabled: false }) | `withdraw-consent-of-binding` (and `auto-sync-step`, which every explicit off moves) |
 * | invalidateAllCardSyncAuthorization (recovery) | `revoke-all-grants`; every open extension set `recovery-review` |
 *
 * No path in the table touches a receipt (Revision 8). `close-pairing-of-device`
 * closes only a `redeemed` pairing: that condition keeps an approved pairing's
 * history and leaves every already closed pairing alone (load-bearing; a test
 * pins it). Retention runs `touch-set` in every chunk that changes a set's
 * listed items, and phase 7's audit step only through `audit-cutoff-refresh`
 * and `audit-delete-chunk` (one horizon per call).
 */

/** The named parameters each statement binds, exactly as the design writes them. */
export interface CardSyncStatementParams {
  'adjustment-reversible': { value_change: 0 | 1; committed_revision: number; transaction_id: string };
  'auto-sync-step': {
    now: string; binding_id: string; enabled: 0 | 1; expected_version: number | null; expected_auto_sync_revision: number | null;
  };
  'revoke-grants-of-device': { now: string; device_id: string };
  'revoke-grants-of-binding': { now: string; binding_id: string };
  'revoke-grant': { now: string; grant_id: string };
  'revoke-all-grants': { now: string };
  'withdraw-consent-of-binding': { binding_id: string };
  'quarantine-sets-of-device': { device_id: string };
  'cancel-plans-of-device': { now: string; device_id: string };
  'close-pairing-of-device': { now: string; device_id: string };
  'set-level-item': { set_id: string };
  'set-items-page': { set_id: string; after_key: number; limit: number };
  'values-at-revision': { transaction_id: string; revision: number };
  'plan-effects-page': { plan_id: string; after_ordinal: number; limit: number };
  'transaction-history-page': { transaction_id: string; before_created_at: string; before_id: string; limit: number };
  'revertible-event': { transaction_id: string };
  'transaction-aliases-page': { transaction_id: string; after_created_at: string; after_id: string; limit: number };
  'transaction-merged-page': { transaction_id: string; after_removed_at: string; after_id: string; limit: number };
  'touch-set': { set_id: string };
  'audit-cutoff-refresh': { id: string; now: string };
  'audit-delete-chunk': { now: string };
  'audit-cutoff-ahead': { now: string };
}

/** The statements that write: run them, and read how many rows they changed. */
export const CARD_SYNC_WRITE_STATEMENTS = [
  'auto-sync-step', 'revoke-grants-of-device', 'revoke-grants-of-binding', 'revoke-grant', 'revoke-all-grants',
  'withdraw-consent-of-binding', 'quarantine-sets-of-device', 'cancel-plans-of-device', 'close-pairing-of-device', 'touch-set',
  'audit-cutoff-refresh', 'audit-delete-chunk',
] as const satisfies readonly CardSyncQueryName[];
export type CardSyncWriteStatement = (typeof CARD_SYNC_WRITE_STATEMENTS)[number];
export type CardSyncReadStatement = Exclude<CardSyncQueryName, CardSyncWriteStatement>;

/** One row of a ledger snapshot or of the current row, as `values-at-revision` returns it. */
export interface CardSyncValuesRow {
  from_current: 0 | 1;
  at_revision: number;
  status: 'pending' | 'posted' | 'removed';
  transaction_date: string;
  posted_date: string | null;
  amount_minor: number;
  original_amount_minor: number | null;
  original_currency: string | null;
  kind: string;
  description: string;
  merchant: string | null;
  issuer_category: string | null;
  card_scope_id: string;
  removed_reason: string | null;
  removed_from_status: 'pending' | 'posted' | null;
}

/** The rows each read returns. */
export interface CardSyncStatementRows {
  'adjustment-reversible': { reversible: 0 | 1 | null };
  'set-level-item': { item_id: string; item_key: -1 };
  'set-items-page': { item_id: string; item_key: number };
  'values-at-revision': CardSyncValuesRow;
  'plan-effects-page': {
    ordinal: number; op: string; review_item_id: string | null; observation_ordinal: number | null; content_digest: string | null;
    transaction_id: string | null; expected_revision: number | null; new_ref: number | null; related_transaction_id: string | null;
    related_revision: number | null; scope_id: string | null; promote: 0 | 1; restore: 0 | 1; identity_count: number;
    reverses_event_id: string | null;
  };
  'transaction-history-page': { id: string; created_at: string; card_transaction_id: string };
  'revertible-event': { event_id: string };
  'transaction-aliases-page': { identity_id: string; created_at: string };
  'transaction-merged-page': { transaction_id: string; removed_at: string };
  'audit-cutoff-ahead': { ahead: 0 | 1 };
}

const WRITES: ReadonlySet<string> = new Set(CARD_SYNC_WRITE_STATEMENTS);

/** Every named statement prepared on one connection. Preparing all 22 up front proves each compiles against the schema. */
export class CardSyncStatements {
  private readonly prepared: ReadonlyMap<CardSyncQueryName, Statement>;

  constructor(private readonly db: DB) {
    this.prepared = new Map((Object.keys(CARD_SYNC_QUERIES) as CardSyncQueryName[])
      .map((name) => [name, db.prepare(CARD_SYNC_QUERIES[name])]));
    for (const [name, statement] of this.prepared) {
      if (statement.reader === WRITES.has(name)) throw new Error(`card sync statement ${name} is misclassified`);
    }
  }

  /** Runs a writing statement; returns how many rows it changed. */
  run<N extends CardSyncWriteStatement>(name: N, params: CardSyncStatementParams[N]): number {
    return this.statement(name).run(params).changes;
  }

  /** The first row of a read, or undefined. */
  get<N extends CardSyncReadStatement>(name: N, params: CardSyncStatementParams[N]): CardSyncStatementRows[N] | undefined {
    return this.statement(name).get(params) as CardSyncStatementRows[N] | undefined;
  }

  /** Every row of a read, in the statement's order. */
  all<N extends CardSyncReadStatement>(name: N, params: CardSyncStatementParams[N]): Array<CardSyncStatementRows[N]> {
    return this.statement(name).all(params) as Array<CardSyncStatementRows[N]>;
  }

  /** `EXPLAIN QUERY PLAN` of a statement with these parameters: the `detail` of each step, for index-range tests. */
  queryPlan<N extends CardSyncQueryName>(name: N, params: CardSyncStatementParams[N]): string[] {
    return (this.db.prepare(`EXPLAIN QUERY PLAN ${CARD_SYNC_QUERIES[name]}`).all(params) as Array<{ detail: string }>).map((r) => r.detail);
  }

  private statement(name: CardSyncQueryName): Statement {
    const statement = this.prepared.get(name);
    if (!statement) throw new Error(`no card sync statement named ${name}`);
    return statement;
  }
}
