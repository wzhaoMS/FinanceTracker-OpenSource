import type { Database as DB } from 'better-sqlite3';
import {
  canonicalJson, cardSyncPayloadDigest, isCardSyncDigest, reconcileCardImport, validateCardSyncPayloadV2, type CardSyncPayloadV2,
  type JsonValue,
} from '@finance-tracker/shared';

import { captureFingerprintIdentity, newCardSyncId, newCardSyncRowId, rowContentDigest } from '../cardSyncDigests.js';
import { CARD_SYNC_ADMISSIONS } from '../cardLedger/admissions.js';
import type { PlanObservation } from '../cardLedger/classify.js';
import { LedgerView } from '../cardLedger/ledgerView.js';
import { simulate, type StatementDifference } from '../cardLedger/simulate.js';
import { currentSourceAuthorization, readBinding } from './authorization.js';
import { insertRows } from './bulk.js';
import { audit, secondsAfter, type CardSyncContext } from './context.js';
import { insertItems } from './items.js';
import { cardSyncRefusal } from './refusals.js';
import { deviceRun } from './runs.js';
import { excludedRows, readSet, scopeKinds, type CardSyncSetState } from './sets.js';

/**
 * Acceptance of a device upload (E1b design §5.4): one transaction that
 * re-checks the current-source authorization, the run and the payload,
 * charges the review quotas and stores the set, its observations, coverage,
 * receipt and first review items. It never writes a ledger row (§4.1).
 */

export interface CardSyncAcceptanceReceipt {
  runId: string;
  observationSetId: string;
  payloadDigest: string;
  acceptedAt: string;
  /** The set's review deadline (never extended). */
  expiresAt: string;
  rowCount: number;
  reviewCount: number;
  state: CardSyncSetState;
  replayed: boolean;
}

const DAY_SECONDS = 86_400;
const DEVICE_ID = /^dev_[a-p]{32}$/;
const CLIENT_RUN_ID = /^crn_[a-p]{32}$/;
const GENERATION = /^agn_[a-p]{32}$/;
const CHECK_FIELDS = { charges: 'charges', credits: 'credits', net: 'net', balance: 'new-balance' } as const;

const OBSERVATION_COLUMNS = ['id', 'observation_set_id', 'origin', 'card_account_id', 'ordinal', 'file_row_index', 'source_scope_id',
  'source_scope_kind', 'identity_namespace', 'namespace_kind', 'external_id_hash', 'fingerprint', 'identity_hash', 'transaction_date',
  'posted_date', 'status', 'amount_minor', 'currency', 'original_amount_minor', 'original_currency', 'kind', 'description', 'merchant',
  'issuer_category', 'content_digest'] as const;
const SECONDARY_COLUMNS = ['id', 'observation_id', 'ordinal', 'namespace', 'namespace_kind', 'id_hash'] as const;
const COVERAGE_COLUMNS = ['id', 'card_account_id', 'card_scope_id', 'source_kind', 'source', 'import_batch_id', 'observation_set_id',
  'entry_ordinal', 'status', 'requested_start', 'requested_end', 'requested_basis', 'observed_start', 'observed_end', 'observed_basis',
  'claimed_completeness', 'verified_completeness', 'termination', 'page_count', 'evidence', 'ledger_state', 'observed_at',
  'recorded_at', 'updated_at'] as const;

/** Contract 1 never verifies a completeness claim: verified = min(claimed, partial) (§2.15). */
const verifiedCompleteness = (claimed: string) => claimed === 'complete' ? 'partial' : claimed;

/** The first statement check that fails, as the set-level item records it; null when the statement agrees or is absent. */
export interface CardSyncQuotaUsage {
  sets: number;
  rows: number;
  bytes: number;
}

const OPEN_STATES = "('accepted-uncommitted', 'needs-review', 'blocked-review', 'recovery-review')";

/**
 * What the review quotas charge (I24; slice 2 review r1, finding 6): the
 * unresolved review content, open sets (past their deadline too, until
 * retention expires them) with their rows and bytes, plus every exact
 * receipt still kept, whatever its set's state. A committed set's rows are
 * ledger history and provenance, never review work: they are not charged;
 * discard and expiry release a set's share.
 */
export function reviewQuotaUsage(db: DB, filter: { cardAccountId?: string; deviceId?: string }): CardSyncQuotaUsage {
  const where = filter.cardAccountId !== undefined ? 'AND s.card_account_id = :scope'
    : filter.deviceId !== undefined ? 'AND s.device_id = :scope' : '';
  const scope = filter.cardAccountId ?? filter.deviceId ?? null;
  return db.prepare(`SELECT
      (SELECT count(*) FROM card_sync_observation_sets s WHERE s.state IN ${OPEN_STATES} ${where}) AS sets,
      (SELECT coalesce(sum(s.row_count), 0) FROM card_sync_observation_sets s WHERE s.state IN ${OPEN_STATES} ${where}) AS rows,
      (SELECT coalesce(sum(s.byte_count), 0) FROM card_sync_observation_sets s WHERE s.state IN ${OPEN_STATES} ${where})
        + (SELECT coalesce(sum(r.byte_length), 0) FROM card_sync_payload_receipts r
             JOIN card_sync_observation_sets s ON s.id = r.observation_set_id WHERE 1 = 1 ${where}) AS bytes`)
    .get(scope === null ? {} : { scope }) as CardSyncQuotaUsage;
}

export function statementDifference(payload: Pick<CardSyncPayloadV2, 'totals' | 'statement'>): StatementDifference | null {
  const failed = reconcileCardImport(payload.totals.posted, payload.statement).checks.find((check) => !check.ok);
  return failed ? { field: CHECK_FIELDS[failed.check], expectedMinor: failed.expectedMinor, actualMinor: failed.actualMinor } : null;
}

function receiptOf(db: CardSyncContext['db'], run: { id: string }, setId: string, replayed: boolean): CardSyncAcceptanceReceipt {
  const set = readSet(db, setId)!;
  const reviewCount = db.prepare(`SELECT count(*) FROM card_reconciliation_suggestions
    WHERE observation_set_id = ? AND status IN ('open', 'decided')`).pluck().get(setId) as number;
  return {
    runId: run.id, observationSetId: set.id, payloadDigest: set.payload_digest!, acceptedAt: set.accepted_at, expiresAt: set.expires_at,
    rowCount: set.row_count, reviewCount, state: set.state, replayed,
  };
}

/**
 * §5.4's acceptance, in the design's order: (1) the current-source
 * authorization with the device, again; (2) the run (its device, client run
 * id, state and window; an accepted run with the same digest answers its
 * stored receipt, `replayed`, with no quota charge); (3) re-validation of the
 * canonical bytes; (4) quotas; (5) the writes. The ACK goes out only after
 * the commit; a guard refusal in any column aborts it whole.
 */
export function acceptCardSyncObservations(ctx: CardSyncContext, input: {
  deviceId: string; runId: string; clientRunId: string; canonicalJson: string; payloadDigest: string; expectedGeneration: string;
}): CardSyncAcceptanceReceipt {
  const { db, now } = ctx;
  if (typeof input?.deviceId !== 'string' || !DEVICE_ID.test(input.deviceId)) throw cardSyncRefusal('principal-not-allowed');
  if (typeof input.expectedGeneration !== 'string' || !GENERATION.test(input.expectedGeneration)) throw cardSyncRefusal('invalid-request');
  const run = deviceRun(db, input.deviceId, input.runId);
  const binding = readBinding(db, run.binding_id)!;
  const source = currentSourceAuthorization(db, now, {
    binding, contractVersion: run.contract_version, expectedGeneration: input.expectedGeneration,
    device: { id: input.deviceId, bindingVersion: run.binding_version },
  });

  if (typeof input.clientRunId !== 'string' || !CLIENT_RUN_ID.test(input.clientRunId) || input.clientRunId !== run.client_run_id) {
    throw cardSyncRefusal('idempotency-conflict');
  }
  if (run.acceptance_state === 'accepted') {
    if (input.payloadDigest !== run.payload_digest || run.set_id === null) throw cardSyncRefusal('idempotency-conflict');
    return receiptOf(db, run, run.set_id, true);
  }
  if (run.acceptance_state !== 'open') throw cardSyncRefusal('run-closed');
  if (now >= run.upload_expires_at) throw cardSyncRefusal('run-expired');

  // (3) Re-validation: what E2 checked is checked again here, on the bytes that will be stored.
  if (typeof input.canonicalJson !== 'string' || !isCardSyncDigest('payload', input.payloadDigest)) {
    throw cardSyncRefusal('payload-invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.canonicalJson);
  } catch {
    throw cardSyncRefusal('payload-invalid');
  }
  const validation = validateCardSyncPayloadV2(parsed);
  if (!validation.ok) throw cardSyncRefusal('payload-invalid');
  const payload = validation.payload;
  if (canonicalJson(payload as unknown as JsonValue) !== input.canonicalJson || cardSyncPayloadDigest(payload) !== input.payloadDigest) {
    throw cardSyncRefusal('payload-digest-mismatch');
  }
  if (payload.bindingId !== run.binding_id || payload.bindingVersion !== run.binding_version
    || payload.bindingVersion !== binding.version) {
    throw cardSyncRefusal('binding-stale');
  }
  if (payload.contractVersion !== run.contract_version) throw cardSyncRefusal('contract-unsupported');
  if (payload.source !== binding.source || payload.issuer !== binding.issuer || payload.mode !== source.mode
    || payload.currency !== binding.currency) {
    throw cardSyncRefusal('payload-invalid');
  }
  const scopes = new Map((db.prepare(`SELECT b.card_scope_id AS id, b.card_scope_kind AS kind FROM card_source_binding_scopes b
      JOIN card_scopes s ON s.id = b.card_scope_id
    WHERE b.binding_id = ? AND b.status = 'active' AND s.status = 'active'`).all(binding.id) as
    Array<{ id: string; kind: 'known' | 'unknown' }>).map((s) => [s.id, s.kind]));
  if (payload.rows.some((row) => !scopes.has(row.cardScopeId)) || payload.coverage.some((entry) => !scopes.has(entry.cardScopeId))) {
    throw cardSyncRefusal('scope-not-in-binding');
  }
  if (db.prepare('SELECT 1 FROM card_sync_observation_sets WHERE capture_id = ?').get(payload.captureId) !== undefined) {
    throw cardSyncRefusal('capture-already-accepted');
  }

  // (4) Quotas per account, device and globally (I24): nothing accepted, nothing evicted.
  const byteLength = Buffer.byteLength(input.canonicalJson, 'utf8');
  const policy = db.prepare(`SELECT review_retention_days, receipt_retention_days, quota_account_sets, quota_account_rows,
      quota_account_bytes, quota_device_sets, quota_device_rows, quota_device_bytes, quota_global_sets, quota_global_rows,
      quota_global_bytes FROM card_sync_policy WHERE id = 'card-sync-policy'`).get() as Record<string, number>;
  const charge = { sets: 1, rows: payload.rows.length, bytes: byteLength * 2 };
  const over = (used: CardSyncQuotaUsage, scope: 'account' | 'device' | 'global') =>
    used.sets + charge.sets > policy[`quota_${scope}_sets`] || used.rows + charge.rows > policy[`quota_${scope}_rows`]
    || used.bytes + charge.bytes > policy[`quota_${scope}_bytes`];
  if (over(reviewQuotaUsage(db, { cardAccountId: binding.card_account_id }), 'account')
    || over(reviewQuotaUsage(db, { deviceId: input.deviceId }), 'device') || over(reviewQuotaUsage(db, {}), 'global')) {
    throw cardSyncRefusal('review-quota-exceeded');
  }

  // (5) The set and what it holds, then its first review items (§4.5).
  const setId = newCardSyncId('obs_');
  const accountId = binding.card_account_id;
  const observations: PlanObservation[] = payload.rows.map((row, ordinal) => {
    const stable = row.externalIdHash !== null;
    const scopeKind = scopes.get(row.cardScopeId)!;
    const idHash = stable ? row.externalIdHash! : captureFingerprintIdentity(payload.captureId, row.fingerprint!);
    return {
      ordinal, id: newCardSyncRowId('card-obsrow-'), itemId: null, origin: 'extension', scopeId: row.cardScopeId, scopeKind,
      tuples: [
        { scopeId: row.cardScopeId, scopeKind, namespace: row.identityNamespace, namespaceKind: stable ? 'stable' : 'capture', idHash },
        ...row.secondaryIds.map((secondary) => ({
          scopeId: row.cardScopeId, scopeKind, namespace: secondary.namespace, namespaceKind: 'stable' as const, idHash: secondary.idHash,
        })),
      ],
      values: {
        transactionDate: row.transactionDate, postedDate: row.postedDate, status: row.status, amountMinor: row.amountMinor,
        originalAmountMinor: row.originalAmountMinor, originalCurrency: row.originalCurrency, kind: row.kind, description: row.description,
        merchant: row.merchant, issuerCategory: row.issuerCategory,
      },
      content: rowContentDigest({
        transactionDate: row.transactionDate, postedDate: row.postedDate, status: row.status, amountMinor: row.amountMinor,
        kind: row.kind, description: row.description, merchant: row.merchant, issuerCategory: row.issuerCategory,
        originalAmountMinor: row.originalAmountMinor, originalCurrency: row.originalCurrency,
      }),
    };
  });
  const view = new LedgerView(db, accountId, binding.currency);
  const ledgerRevision = view.ledgerRevision();
  const difference = statementDifference(payload);
  const { actions } = simulate({
    mode: 'classify', observations, decisions: new Map(), excluded: excludedRows(view, observations),
    knownScopes: new Set([...scopes].filter(([, kind]) => kind === 'known').map(([id]) => id)),
    statement: difference ? { itemId: null, difference } : null,
  }, view, CARD_SYNC_ADMISSIONS, scopeKinds(db, accountId));
  const reviews = actions.filter((action) => action.op === 'review');
  const state: CardSyncSetState = reviews.length > 0 ? 'needs-review' : 'accepted-uncommitted';
  const expiresAt = secondsAfter(now, policy.review_retention_days * DAY_SECONDS);
  const statement = payload.statement;

  db.prepare(`INSERT INTO card_sync_observation_sets (id, origin, card_account_id, issuer, currency, run_id, device_id, binding_id,
      binding_version, capture_id, payload_digest, contract_version, mode, owner, source, parser_version, authorization_generation,
      guard_revision, observed_at, accepted_at, expires_at, state, version, review_ledger_revision, row_count, byte_count,
      producer_rejected_count, statement_present, statement_charges_minor, statement_credits_minor, statement_net_minor,
      statement_previous_balance_minor, statement_new_balance_minor, open_count, receipt_state)
    VALUES (?, 'extension', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'kept')`)
    .run(setId, accountId, binding.issuer, binding.currency, run.id, input.deviceId, binding.id, binding.version, payload.captureId,
      input.payloadDigest, payload.contractVersion, payload.mode, payload.owner, payload.source, payload.parserVersion,
      input.expectedGeneration, ctx.guardRevision, payload.observedAt, now, expiresAt, state, ledgerRevision, payload.rows.length,
      byteLength, payload.rejectedCount, statement ? 1 : 0, statement?.chargesMinor ?? null, statement?.creditsMinor ?? null,
      statement?.netMinor ?? null, statement?.previousBalanceMinor ?? null, statement?.newBalanceMinor ?? null, payload.rows.length);
  const hints = [...new Set(payload.cards)].sort();
  insertRows(db, 'card_sync_set_card_hints', ['observation_set_id', 'origin', 'ordinal', 'last4'],
    hints.map((last4, ordinal) => [setId, 'extension', ordinal, last4]));
  insertRows(db, 'card_source_observations', OBSERVATION_COLUMNS, payload.rows.map((row, ordinal) => {
    const o = observations[ordinal];
    return [o.id, setId, 'extension', accountId, ordinal, null, o.scopeId, o.scopeKind, row.identityNamespace, o.tuples[0].namespaceKind,
      row.externalIdHash, row.externalIdHash === null ? row.fingerprint : null, o.tuples[0].idHash, row.transactionDate, row.postedDate,
      row.status, row.amountMinor, binding.currency, row.originalAmountMinor, row.originalCurrency, row.kind, row.description,
      row.merchant, row.issuerCategory, o.content];
  }));
  insertRows(db, 'card_observation_secondary_ids', SECONDARY_COLUMNS, payload.rows.flatMap((row, ordinal) => row.secondaryIds.map(
    (secondary, index) => [newCardSyncRowId('card-obsid-'), observations[ordinal].id, index + 1, secondary.namespace, 'stable',
      secondary.idHash])));
  insertRows(db, 'card_coverage_windows', COVERAGE_COLUMNS, payload.coverage.map((entry, ordinal) => [
    newCardSyncRowId('card-cover-'), accountId, entry.cardScopeId, 'extension', payload.source, null, setId, ordinal, entry.status,
    entry.requested?.start ?? null, entry.requested?.end ?? null, entry.requested?.dateBasis ?? null, entry.observed?.start ?? null,
    entry.observed?.end ?? null, entry.observed?.dateBasis ?? null, entry.completeness, verifiedCompleteness(entry.completeness),
    entry.termination, entry.pageCount, 'extension-claimed', 'observed-uncommitted', payload.observedAt, now, now,
  ]));
  const receiptDays = Math.min(7, policy.receipt_retention_days);
  db.prepare(`INSERT INTO card_sync_payload_receipts (observation_set_id, payload_digest, canonical_json, byte_length, accepted_at,
      expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(setId, input.payloadDigest, input.canonicalJson, byteLength, now, secondsAfter(now, receiptDays * DAY_SECONDS));
  insertItems(db, now, { id: setId, card_account_id: accountId }, reviews.map((action) => ({
    observationId: action.source ? observations[action.source.ordinal].id : null, review: action.review!,
    statement: action.statement,
  })), ledgerRevision);
  const closed = db.prepare(`UPDATE card_sync_runs SET acceptance_state = 'accepted', payload_digest = ?, accepted_at = ?, closed_at = ?
    WHERE id = ? AND acceptance_state = 'open'`).run(input.payloadDigest, now, now, run.id).changes;
  if (closed !== 1) throw cardSyncRefusal('run-closed');
  audit(ctx, 'set-accepted', { kind: 'device', ref: input.deviceId }, {
    cardAccountId: accountId, bindingId: binding.id, deviceId: input.deviceId, runId: run.id, observationSetId: setId,
    rowCount: payload.rows.length, byteCount: byteLength, itemCount: reviews.length, generation: input.expectedGeneration,
  });
  return receiptOf(db, run, setId, false);
}

/** The stored canonical bytes of an accepted payload, while the receipt is kept (`receipt-expired` afterwards, §5.4). */
export function getCardSyncPayloadReceipt(ctx: CardSyncContext, input: { setId: string }):
  { canonicalJson: string; payloadDigest: string; acceptedAt: string; expiresAt: string } {
  const set = readSet(ctx.db, input?.setId);
  if (!set || set.origin !== 'extension') throw cardSyncRefusal('not-found');
  const receipt = ctx.db.prepare(`SELECT canonical_json AS canonicalJson, payload_digest AS payloadDigest, accepted_at AS acceptedAt,
      expires_at AS expiresAt FROM card_sync_payload_receipts WHERE observation_set_id = ?`).get(set.id) as
    { canonicalJson: string; payloadDigest: string; acceptedAt: string; expiresAt: string } | undefined;
  if (!receipt || set.receipt_state !== 'kept' || ctx.now >= receipt.expiresAt) throw cardSyncRefusal('receipt-expired');
  return receipt;
}

/**
 * The owner deletes a receipt early (§5.3.1, §5.4): the set gives it up
 * first (`receipt_state = 'deleted'`, version + 1), then the row goes (the
 * database refuses the other order). Idempotent once gone.
 */
export function deleteCardSyncReceipt(ctx: CardSyncContext, input: { setId: string; actorRef: string }): void {
  const set = readSet(ctx.db, input?.setId);
  if (!set || set.origin !== 'extension') throw cardSyncRefusal('not-found');
  if (set.receipt_state !== 'kept') return;
  ctx.db.prepare(`UPDATE card_sync_observation_sets SET receipt_state = 'deleted', version = version + 1 WHERE id = ? AND version = ?`)
    .run(set.id, set.version);
  ctx.db.prepare('DELETE FROM card_sync_payload_receipts WHERE observation_set_id = ?').run(set.id);
  audit(ctx, 'receipt-deleted', { kind: 'session', ref: input.actorRef }, {
    cardAccountId: set.card_account_id, observationSetId: set.id, versionBefore: set.version, versionAfter: set.version + 1,
  });
}
