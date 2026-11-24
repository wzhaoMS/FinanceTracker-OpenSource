import type { Database as DB } from 'better-sqlite3';
import {
  assembleCardSyncPayloadV2, buildCardSyncPayloadV2, type CardSyncCoverageEntry, type CardSyncDateRange,
  type CardSyncDraftV2, type CardSyncPayloadV2, type CardSyncRowDraftV2,
} from '@finance-tracker/shared';

import type { PlanObservation } from '../cardLedger/classify.js';
import { cardSyncPayloadDigestNative } from '../cardSyncDigests.js';
import type { LedgerRow, LedgerView } from '../cardLedger/ledgerView.js';
import { cardSyncRefusal } from './refusals.js';

/**
 * Observation sets as the repository reads them (E1b design §2.8–§2.10,
 * §5.4–§5.6): the stored header, the observations as the planner's input,
 * and the payload rebuilt from them (rehydration, finding 5).
 */

export const OPEN_SET_STATES = ['accepted-uncommitted', 'needs-review', 'blocked-review', 'recovery-review'] as const;
export type CardSyncSetState = (typeof OPEN_SET_STATES)[number] | 'committed' | 'rejected' | 'expired-unreviewed';

export interface SetRow {
  id: string; origin: 'extension' | 'file'; card_account_id: string; issuer: string; currency: string; run_id: string | null;
  device_id: string | null; binding_id: string | null; binding_version: number | null; capture_id: string | null;
  payload_digest: string | null; contract_version: number | null; mode: string | null; owner: string | null;
  import_batch_id: string | null; file_chunk: number | null; source: string; parser_version: string;
  authorization_generation: string | null; guard_revision: number; observed_at: string | null; accepted_at: string; expires_at: string;
  state: CardSyncSetState; version: number; review_ledger_revision: number; row_count: number; byte_count: number;
  producer_rejected_count: number; statement_present: number; statement_charges_minor: number | null;
  statement_credits_minor: number | null; statement_net_minor: number | null; statement_previous_balance_minor: number | null;
  statement_new_balance_minor: number | null; open_count: number; inserted_count: number; updated_count: number; matched_count: number;
  attributed_count: number; unchanged_count: number; rejected_count: number; expired_count: number;
  receipt_state: 'none' | 'kept' | 'expired' | 'deleted'; closed_at: string | null; close_reason: string | null;
  discard_reason: string | null; closed_by_ref: string | null; content_purged_at: string | null;
}

const SET_ID = /^obs_[a-p]{32}$/;

export const isOpenSet = (set: Pick<SetRow, 'state'>) => (OPEN_SET_STATES as readonly string[]).includes(set.state);

export function readSet(db: DB, setId: unknown): SetRow | undefined {
  if (typeof setId !== 'string' || !SET_ID.test(setId)) return undefined;
  return db.prepare('SELECT * FROM card_sync_observation_sets WHERE id = ?').get(setId) as SetRow | undefined;
}

export function requireSet(db: DB, setId: unknown): SetRow {
  const set = readSet(db, setId);
  if (!set) throw cardSyncRefusal('not-found');
  return set;
}

/** The account's ledger revision: what review marks and plans pin. */
export function ledgerRevisionOf(db: DB, cardAccountId: string): number {
  return db.prepare('SELECT ledger_revision FROM card_accounts WHERE id = ?').pluck().get(cardAccountId) as number;
}

interface ObservationRecord {
  id: string; ordinal: number; origin: 'extension' | 'file'; source_scope_id: string; source_scope_kind: 'known' | 'unknown' | 'legacy';
  identity_namespace: string; namespace_kind: 'legacy-file' | 'stable' | 'capture'; external_id_hash: string | null;
  fingerprint: string | null; identity_hash: string; transaction_date: string; posted_date: string | null; status: 'pending' | 'posted';
  amount_minor: number; original_amount_minor: number | null; original_currency: string | null; kind: string; description: string;
  merchant: string | null; issuer_category: string | null; content_digest: string; item_id: string | null; state: string;
}

/** A stored observation with what the planner and the writer need. */
export interface SetObservation extends PlanObservation {
  externalIdHash: string | null;
  fingerprint: string | null;
  state: string;
}

/** The set's observations in ordinal order (open ones only, or all), each with its tuples and its item. */
export function setObservations(db: DB, setId: string, which: 'open' | 'all'): SetObservation[] {
  const records = db.prepare(`SELECT o.id, o.ordinal, o.origin, o.source_scope_id, o.source_scope_kind, o.identity_namespace,
      o.namespace_kind, o.external_id_hash, o.fingerprint, o.identity_hash, o.transaction_date, o.posted_date, o.status, o.amount_minor,
      o.original_amount_minor, o.original_currency, o.kind, o.description, o.merchant, o.issuer_category, o.content_digest, o.state,
      r.id AS item_id
    FROM card_source_observations o LEFT JOIN card_reconciliation_suggestions r ON r.observation_id = o.id
    WHERE o.observation_set_id = ? ${which === 'open' ? "AND o.state = 'open'" : ''}
    ORDER BY o.ordinal`).all(setId) as ObservationRecord[];
  const secondary = new Map<string, Array<{ namespace: string; id_hash: string }>>();
  for (const s of db.prepare(`SELECT i.observation_id, i.namespace, i.id_hash FROM card_observation_secondary_ids i
      JOIN card_source_observations o ON o.id = i.observation_id
    WHERE o.observation_set_id = ? ORDER BY i.observation_id, i.ordinal`).all(setId) as
    Array<{ observation_id: string; namespace: string; id_hash: string }>) {
    const list = secondary.get(s.observation_id) ?? [];
    list.push(s);
    secondary.set(s.observation_id, list);
  }
  return records.map((o) => ({
    ordinal: o.ordinal, id: o.id, itemId: o.item_id, origin: o.origin, scopeId: o.source_scope_id, scopeKind: o.source_scope_kind,
    tuples: [
      { scopeId: o.source_scope_id, scopeKind: o.source_scope_kind, namespace: o.identity_namespace, namespaceKind: o.namespace_kind,
        idHash: o.identity_hash },
      ...(secondary.get(o.id) ?? []).map((s) => ({
        scopeId: o.source_scope_id, scopeKind: o.source_scope_kind, namespace: s.namespace, namespaceKind: 'stable' as const,
        idHash: s.id_hash,
      })),
    ],
    values: {
      transactionDate: o.transaction_date, postedDate: o.posted_date, status: o.status, amountMinor: o.amount_minor,
      originalAmountMinor: o.original_amount_minor, originalCurrency: o.original_currency, kind: o.kind, description: o.description,
      merchant: o.merchant, issuerCategory: o.issuer_category,
    },
    content: o.content_digest, externalIdHash: o.external_id_hash, fingerprint: o.fingerprint, state: o.state,
  }));
}

/** Which rows each observation must not be offered (§4.4's first exclusion). */
export interface RowExclusions {
  forObservation(ordinal: number): { has(rowId: string): boolean };
}

/**
 * §4.4's first exclusion: for each observation, the rows another observation
 * of the same set reaches by identity (multiplicity inside one capture is
 * kept, never offered as one row). Linear in the set: each row remembers
 * the observations that reach it.
 */
export function excludedRows(view: LedgerView, observations: readonly PlanObservation[]): RowExclusions {
  const reachers = new Map<string, number[]>();
  for (const observation of observations) {
    const rows = new Set(observation.tuples.flatMap((tuple) => {
      const identity = view.identity(tuple);
      return identity?.status === 'active' ? [identity.canonicalId] : [];
    }));
    for (const row of rows) reachers.set(row, [...(reachers.get(row) ?? []), observation.ordinal]);
  }
  return {
    forObservation: (ordinal) => ({
      has: (rowId) => (reachers.get(rowId) ?? []).some((other) => other !== ordinal),
    }),
  };
}

/** The binding's active known scopes (the targets an owner may attribute to); a file set has none. */
export function knownScopesOf(db: DB, set: Pick<SetRow, 'binding_id'>): Set<string> {
  if (set.binding_id === null) return new Set();
  return new Set(db.prepare(`SELECT s.id FROM card_source_binding_scopes b JOIN card_scopes s ON s.id = b.card_scope_id
    WHERE b.binding_id = ? AND s.kind = 'known' AND s.status = 'active'`).pluck().all(set.binding_id) as string[]);
}

/** Scope id → kind for one account, as the overlay labels rows. */
export function scopeKinds(db: DB, cardAccountId: string): (scopeId: string) => LedgerRow['scopeKind'] {
  const kinds = new Map((db.prepare('SELECT id, kind FROM card_scopes WHERE card_account_id = ?').all(cardAccountId) as
    Array<{ id: string; kind: LedgerRow['scopeKind'] }>).map((s) => [s.id, s.kind]));
  return (scopeId) => {
    const kind = kinds.get(scopeId);
    if (!kind) throw new Error('card ledger: a scope outside the account');
    return kind;
  };
}

/**
 * Every component of an extension set's payload as stored (§5.4, finding 5): the header, card hints, coverage by
 * `entry_ordinal`, observations by `ordinal` with their secondary ids, as the E1a draft they were accepted from, and each
 * observation's stored fingerprint. Null when the set has no payload to read (not an extension set, its content purged,
 * or not its stated number of observations).
 */
function storedPayloadDraft(db: DB, set: SetRow): { draft: CardSyncDraftV2; fingerprints: Array<string | null> } | null {
  if (set.origin !== 'extension' || set.content_purged_at !== null) return null;
  const observations = setObservations(db, set.id, 'all');
  if (observations.length !== set.row_count) return null;
  const coverage = (db.prepare(`SELECT card_scope_id, status, requested_start, requested_end, requested_basis, observed_start,
      observed_end, observed_basis, claimed_completeness, page_count, termination
    FROM card_coverage_windows WHERE observation_set_id = ? ORDER BY entry_ordinal`).all(set.id) as Array<{
    card_scope_id: string; status: 'pending' | 'posted'; requested_start: string | null; requested_end: string | null;
    requested_basis: string | null; observed_start: string | null; observed_end: string | null; observed_basis: string | null;
    claimed_completeness: CardSyncCoverageEntry['completeness']; page_count: number; termination: CardSyncCoverageEntry['termination'];
  }>).map((c): CardSyncCoverageEntry => ({
    cardScopeId: c.card_scope_id, status: c.status,
    requested: c.requested_start === null ? null
      : { start: c.requested_start, end: c.requested_end!, dateBasis: c.requested_basis as CardSyncDateRange['dateBasis'] },
    observed: c.observed_start === null ? null
      : { start: c.observed_start, end: c.observed_end!, dateBasis: c.observed_basis as CardSyncDateRange['dateBasis'] },
    completeness: c.claimed_completeness, pageCount: c.page_count, termination: c.termination,
  }));
  const cards = db.prepare('SELECT last4 FROM card_sync_set_card_hints WHERE observation_set_id = ? ORDER BY ordinal').pluck()
    .all(set.id) as string[];
  const rows: CardSyncRowDraftV2[] = observations.map((o) => ({
    transactionDate: o.values.transactionDate, postedDate: o.values.postedDate, status: o.values.status, amountMinor: o.values.amountMinor,
    kind: o.values.kind as CardSyncRowDraftV2['kind'], description: o.values.description, merchant: o.values.merchant,
    issuerCategory: o.values.issuerCategory, externalIdHash: o.externalIdHash, cardScopeId: o.scopeId,
    identityNamespace: o.tuples[0].namespace as CardSyncRowDraftV2['identityNamespace'],
    secondaryIds: o.tuples.slice(1).map((t) => ({ namespace: t.namespace, idHash: t.idHash })) as CardSyncRowDraftV2['secondaryIds'],
    originalAmountMinor: o.values.originalAmountMinor, originalCurrency: o.values.originalCurrency,
  }));
  const draft: CardSyncDraftV2 = {
    contractVersion: set.contract_version!, source: set.source as CardSyncDraftV2['source'], parserVersion: set.parser_version,
    issuer: set.issuer as CardSyncDraftV2['issuer'], currency: set.currency as CardSyncDraftV2['currency'],
    owner: set.owner as CardSyncDraftV2['owner'], cards, bindingId: set.binding_id!, bindingVersion: set.binding_version!,
    captureId: set.capture_id!, observedAt: set.observed_at!, mode: set.mode as CardSyncDraftV2['mode'], coverage,
    rejectedCount: set.producer_rejected_count,
    statement: set.statement_present === 1 ? {
      chargesMinor: set.statement_charges_minor, creditsMinor: set.statement_credits_minor, netMinor: set.statement_net_minor,
      previousBalanceMinor: set.statement_previous_balance_minor, newBalanceMinor: set.statement_new_balance_minor,
    } : null,
    rows,
  };
  return { draft, fingerprints: observations.map((o) => o.fingerprint) };
}

/**
 * Rebuilds an extension set's payload from what was stored (§5.4, finding 5) through E1a's builder (which recomputes
 * fingerprints and totals and validates). `ok` only when the result is valid, its `pd1:` equals the stored digest and
 * every recomputed fingerprint equals the stored one. Never returned to a client as the original.
 */
export function rehydrateCardSyncPayload(db: DB, setId: string): { ok: true; payload: CardSyncPayloadV2 } | { ok: false } {
  const set = readSet(db, setId);
  const stored = set ? storedPayloadDraft(db, set) : null;
  if (!set || !stored) return { ok: false };
  const built = buildCardSyncPayloadV2(stored.draft);
  if (!built.ok || cardSyncPayloadDigestNative(built.payload) !== set.payload_digest) return { ok: false };
  const fingerprintsEqual = built.payload.rows.every((row, index) => row.fingerprint === stored.fingerprints[index]);
  return fingerprintsEqual ? { ok: true, payload: built.payload } : { ok: false };
}

/**
 * The commit's payload-integrity check (§5.4: prepare and commit; slice 2 review r2, finding 1): every stored component
 * read as `rehydrateCardSyncPayload` reads it and assembled exactly as E1a's builder assembles it
 * (`assembleCardSyncPayloadV2`), then the same two comparisons: its `pd1:` equals the stored digest, and every
 * recomputed fingerprint equals the stored one. It leaves out only the builder's re-validation, which can't change the
 * answer:
 * - acceptance stores a set's `pd1:` (immutable) only for a payload it validated;
 * - so an equal digest means these are that payload's canonical bytes (sha256), and a valid payload validates to an
 *   object equal to its assembly;
 * - validation is a pure function of those bytes under the guard revision the plan pins (a changed one is
 *   `preview-stale`);
 * - prepare ran the full rehydration less than 10 minutes before (a plan's life).
 * Any component added, removed, reordered or changed since (a coverage entry, a card hint, an observation's values,
 * ids or fingerprint, a header field) changes the digest or a fingerprint. integrity.test.ts checks that this and the
 * full rehydration agree on every such change. A fifth of the full check's cost: P3 holds with it.
 */
export function cardSyncPayloadSealed(db: DB, set: SetRow): boolean {
  const stored = storedPayloadDraft(db, set);
  if (!stored) return false;
  try {
    const assembled = assembleCardSyncPayloadV2(stored.draft);
    return cardSyncPayloadDigestNative(assembled) === set.payload_digest
      && assembled.rows.every((row, index) => row.fingerprint === stored.fingerprints[index]);
  } catch {
    return false;
  }
}
