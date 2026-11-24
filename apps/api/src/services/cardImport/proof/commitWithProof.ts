import { performance } from 'node:perf_hooks';
import type { Database } from 'better-sqlite3';

import { reconcileCardImport, type CardAccount, type CardImportPayload } from '@finance-tracker/shared';

import { paymentReconciliationReport } from '../../../cli/paymentReconciliationReport.js';
import { readCardPaymentReconciliation } from '../../../routes/cardPaymentReconciliation.js';
import { createCheckingLedgerReader } from '../../checking/ledger.js';
import type { SqliteStateRepo } from '../../sqliteStateRepo.js';
import { ADMISSION_VERIFIERS, checkAdmission, evaluateAdmission, type AdmissionVerifier } from './admission.js';
import { checkCoverage, coverageSpan } from './coverage.js';
import { amazonLinksApplicable, diffLinks, projectedLinks, storedLinks, type LinkedRows } from './links.js';
import { diffPayments, paymentsProjection } from './payments.js';
import { checkLivePermit } from './permit.js';
import {
  assertProofReceipt, PROOF_FORMAT, PROOF_VERSION, ProofReceiptInvalid, serializeProofReceipt, timingBucket,
  type CompletenessBasis, type ProofHoldCode, type ProofReceipt,
} from './receipt.js';
import type { ProofCommitRequest, ProofResolveRequest } from './request.js';
import { categoryEffects, checkRows, checkSuperset, effectiveCategories } from './rows.js';
import { PROOF_FENCES_TABLE, PROOF_RECEIPTS_TABLE, proofSchemaState } from './schema.js';
import { importTableCounts, ledgerIsThisImports, ledgerMarks, takeSnapshot, type StoredRow } from './snapshot.js';

/**
 * The W4 proof (design v1.1 §3): one card import commit, decided inside one outer IMMEDIATE transaction that wraps the
 * route's own commit. better-sqlite3 runs that inner commit as a savepoint, exactly as `commitGuardedCardImport` does.
 *
 * In order:
 * 1. A finished receipt for the job answers at once (repeated), after its replay is checked; nothing is written.
 * 2. F1: the job's durable fence and the client's deadline.
 * 3. The checks that need nothing applied: statement, completeness, first coverage, superset.
 * 4. BEFORE, then the import itself, then AFTER, the replay, and every gate.
 * 5. F2: the deadline again. Then the receipt is written.
 *
 * Any failure throws, and better-sqlite3 rolls the whole transaction back: no row, no coverage, no receipt. A ProofHold
 * carries one value-free code; anything else is an error, and the route answers it as a value-free 500.
 */

export class ProofHold extends Error {
  constructor(readonly code: ProofHoldCode) {
    super(code);
    this.name = 'ProofHold';
  }
}

/** What the route's own commit did, as the proof reads it. */
export interface AppliedImport {
  outcome: 'committed' | 'nothing-new';
  /** The commit's own classification digest (`ipv1:`). */
  planDigest: string;
  /** Rows the batch inserted. */
  newCount: number;
  /** Stored pending rows the import posted by issuer reference (D12). */
  promotedCount: number;
  /** Payload positions left out as exact content twins (D13, or the supervised kit's `--twins content`). */
  skippedRows: readonly number[];
  /** Rows held, or already under review, and duplicates asked about: a clean import has none. */
  heldCount: number;
  reviewCount: number;
  /**
   * The cutover route only: whether the guarded commit answered with its stored cutover receipt (true) or wrote this job's
   * receipt (false). Undefined on the commit route, which writes none.
   */
  cutoverRepeated?: boolean;
}

export interface ProofApply {
  /** The route's own commit, unchanged. It runs as a savepoint of the proof's transaction. */
  commit(): AppliedImport;
  /**
   * The same commit once more: true when it adds nothing at all. The proof runs it in a savepoint it always rolls back,
   * so it can never write.
   */
  reapplyAddsNothing(): boolean;
}

export interface ProofContext {
  db: Database;
  repo: SqliteStateRepo;
  account: CardAccount;
  payload: CardImportPayload;
  /** sha256 of the serialized payload: what the Mac's manifest names. */
  payloadSha256: string;
  route: 'commit' | 'cutover';
  /** Epoch milliseconds. */
  now: () => number;
  verifiers?: readonly AdmissionVerifier[];
}

export interface ProofCommitResult {
  receipt: ProofReceipt;
  repeated: boolean;
  /** What the commit did; null for a repeated job. */
  applied: AppliedImport | null;
}

export type ProofResolveResult = { outcome: 'committed'; receipt: ProofReceipt } | { outcome: 'not-committed' };

class TrialRollback extends Error {}

/** Runs `fn` in a savepoint that is always rolled back; its own errors propagate. */
function trial<T>(db: Database, fn: () => T): T {
  const box: { done: boolean; result?: T } = { done: false };
  try {
    db.transaction(() => {
      box.result = fn();
      box.done = true;
      throw new TrialRollback();
    })();
  } catch (error) {
    if (!(error instanceof TrialRollback)) throw error;
  }
  if (!box.done) throw new Error('trial did not run');
  return box.result as T;
}

function requireSchema(db: Database): void {
  const state = proofSchemaState(db);
  if (state === 'absent') throw new ProofHold('proof-schema-required');
  if (state === 'conflict') throw new ProofHold('proof-schema-conflict');
}

interface StoredReceipt {
  receipt: ProofReceipt;
  accountId: string;
  payloadSha256: string;
}

function readReceipt(db: Database, jobId: string): StoredReceipt | null {
  const row = db.prepare(`SELECT card_account_id AS accountId, payload_sha256 AS payloadSha256, receipt_json AS json
    FROM ${PROOF_RECEIPTS_TABLE} WHERE job_id = ?`).get(jobId) as { accountId: string; payloadSha256: string; json: string } | undefined;
  if (!row) return null;
  let receipt: unknown;
  try {
    receipt = JSON.parse(row.json);
    assertProofReceipt(receipt);
  } catch {
    throw new ProofHold('proof-receipt-conflict');
  }
  if (receipt.jobId !== jobId || receipt.cardAccountId !== row.accountId || receipt.payloadSha256 !== row.payloadSha256) {
    throw new ProofHold('proof-receipt-conflict');
  }
  return { receipt, accountId: row.accountId, payloadSha256: row.payloadSha256 };
}

interface StoredFence {
  accountId: string;
  payloadSha256: string;
  maxResolvedAttempt: number;
}

function readFence(db: Database, jobId: string): StoredFence | null {
  const row = db.prepare(`SELECT card_account_id AS accountId, payload_sha256 AS payloadSha256,
      max_resolved_attempt AS maxResolvedAttempt FROM ${PROOF_FENCES_TABLE} WHERE job_id = ?`)
    .get(jobId) as StoredFence | undefined;
  return row ?? null;
}

/** The job's own receipt or fence must be for this account and payload; another one is a conflict, never this job. */
function sameJob(stored: { accountId: string; payloadSha256: string } | null, ctx: ProofContext | ResolveContext): void {
  if (stored && (stored.accountId !== ctx.account.id || stored.payloadSha256 !== ctx.payloadSha256)) {
    throw new ProofHold('proof-receipt-conflict');
  }
}

/**
 * On the current state: every payload row a plain duplicate or one of the skipped content twins, coverage recorded, and a
 * re-apply that adds nothing. `skipped` gives the twins left out: by position for this commit, or by count for a
 * repeated job, whose receipt records how many.
 */
function replayIsClean(ctx: ProofContext, apply: ProofApply, skipped: { rows: ReadonlySet<number> } | { count: number }): boolean {
  const preview = ctx.repo.previewCardImport({ cardAccountId: ctx.account.id, payload: ctx.payload });
  const { plan } = preview;
  const possible = plan.rows.flatMap((row, index) => (row === 'possible-duplicate' ? [index] : []));
  const twinsOnly = 'rows' in skipped ? possible.every((index) => skipped.rows.has(index)) && possible.length === skipped.rows.size
    : possible.length === skipped.count;
  const rowsClean = twinsOnly && plan.rows.every((row) => row === 'duplicate' || row === 'possible-duplicate');
  if (!rowsClean || plan.conflicts.length > 0 || plan.matches.length > 0 || plan.stale.length > 0 || preview.heldRows.length > 0
    || preview.heldOpenRows.length > 0 || preview.reviewRows.length > 0 || preview.promotedRows.length > 0) return false;
  if (!ctx.repo.cardCoverageCovers(ctx.account.id, ctx.payload.coverage)) return false;
  try {
    return trial(ctx.db, () => apply.reapplyAddsNothing());
  } catch {
    return false;
  }
}

const sameRanges = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

export function commitWithProof(ctx: ProofContext, request: ProofCommitRequest, apply: ProofApply): ProofCommitResult {
  const { db, repo, account, payload } = ctx;
  return db.transaction((): ProofCommitResult => {
    const started = performance.now();
    requireSchema(db);

    // 1. A finished job answers with its receipt; nothing is written.
    const stored = readReceipt(db, request.jobId);
    sameJob(stored, ctx);
    if (stored) {
      if (stored.receipt.route !== ctx.route) throw new ProofHold('proof-receipt-conflict');
      if (!replayIsClean(ctx, apply, { count: stored.receipt.counts.contentTwinsSkipped })) throw new ProofHold('proof-replay');
      return { receipt: stored.receipt, repeated: true, applied: null };
    }

    // 2. F1: an attempt the job's fence covers never begins, nor one past its deadline, nor an automatic one without
    //    ROOT's LIVE PERMIT.
    const fence = readFence(db, request.jobId);
    sameJob(fence, ctx);
    if ((fence && request.attempt <= fence.maxResolvedAttempt) || ctx.now() >= request.deadlineMs) {
      throw new ProofHold('proof-fence-expired');
    }
    const permitAtStart = request.mode === 'automatic' ? checkLivePermit(db, account.issuer) : null;
    if (permitAtStart && !permitAtStart.live) throw new ProofHold('proof-permit-dead');

    // 3. What needs nothing applied: these hold before any write.
    const statement = reconcileCardImport(payload.totals.posted, payload.statement);
    if (statement.status === 'mismatch') throw new ProofHold('proof-statement-mismatch');
    if (statement.status !== 'match' && (request.statementPolicy === 'require-match' || payload.statement !== null)) {
      throw new ProofHold('proof-statement-unchecked');
    }
    // G-COMPLETENESS (roadmap I6): statement totals, or the operator's word under a supervised GO. The job's own claim
    // (pagination end, provider interval) arrives with W4b; until then an automatic activity import holds.
    const basis: CompletenessBasis | null = statement.status === 'match' ? 'statement-totals'
      : request.mode === 'supervised' ? 'operator-attested' : null;
    if (basis === null) throw new ProofHold('proof-completeness-unknown');
    const before = takeSnapshot(db, repo, account.id);
    const coverageBefore = before.coverage.get(account.id) ?? [];
    if (coverageBefore.length === 0) throw new ProofHold('proof-coverage-first');
    const superset = checkSuperset(before, account.id, payload);
    if (superset.code) throw new ProofHold(superset.code);
    if (repo.cardPaymentDecisionsSchemaState() === 'conflict') throw new ProofHold('proof-payments-decisions-conflict');

    // 4. BEFORE.
    const reader = createCheckingLedgerReader(db);
    const nowIso = new Date(ctx.now()).toISOString();
    const countsBefore = importTableCounts(db);
    const ledgerBefore = ledgerMarks(db);
    const paymentsBefore = paymentsProjection(readCardPaymentReconciliation(repo, reader), [...before.accounts.keys()]);
    const categoriesBefore = effectiveCategories(repo);
    const linksApplicable = amazonLinksApplicable(db);
    const storedBefore: LinkedRows = linksApplicable ? storedLinks(db) : new Map();
    const projectedBefore: LinkedRows = linksApplicable ? projectedLinks(db, nowIso) : new Map();
    const verifiers = ctx.verifiers ?? ADMISSION_VERIFIERS;
    const admissionBefore = evaluateAdmission(verifiers, db, account);

    // The import itself: the route's own commit, unchanged.
    const applied = apply.commit();
    if (applied.heldCount !== 0 || applied.reviewCount !== 0) throw new ProofHold('proof-plan-not-clean');
    const skipped = new Set(applied.skippedRows);

    // AFTER, and every gate.
    const after = takeSnapshot(db, repo, account.id);
    const rows = checkRows(before, after, account.id, { newCount: applied.newCount, promotedCount: applied.promotedCount });
    if (rows.code) throw new ProofHold(rows.code);
    if (!replayIsClean(ctx, apply, { rows: skipped })) throw new ProofHold('proof-replay');

    const coverageAfter = after.coverage.get(account.id) ?? [];
    const coverage = checkCoverage(coverageBefore, coverageAfter, payload.coverage);
    if (coverage.code) throw new ProofHold(coverage.code);
    // C6 (v1.1 §3.4): every pre-existing window and batch is unchanged. A committed import adds exactly one batch, the
    // target's, from the payload's source over its coverage, and exactly one window: the target's file window bound to
    // that batch, over the same range. Nothing-new adds neither.
    const batchesAdded = applied.outcome === 'committed' ? 1 : 0;
    const newBatches = [...after.batches].filter(([id]) => !before.batches.has(id));
    const newWindows = [...after.windows].filter(([id]) => !before.windows.has(id));
    const newBatchId = newBatches.length === 1 ? newBatches[0][0] : null;
    const isThisBatch = (row: StoredRow) => row.card_account_id === account.id && row.source === payload.source
      && row.coverage_start === payload.coverage.start && row.coverage_end === payload.coverage.end;
    const isThisWindow = (row: StoredRow) => newBatchId !== null && row.import_batch_id === newBatchId
      && row.card_account_id === account.id && row.source_kind === 'file' && row.source === payload.source
      && row.observation_set_id === null && row.status === 'any' && row.ledger_state === 'committed'
      && row.requested_start === payload.coverage.start && row.requested_end === payload.coverage.end;
    if ([...before.windows].some(([id, window]) => after.windows.get(id)?.digest !== window.digest)
      || [...before.batches].some(([id, batch]) => after.batches.get(id)?.digest !== batch.digest)
      || newBatches.length !== batchesAdded || newWindows.length !== batchesAdded
      || newBatches.some(([, batch]) => !isThisBatch(batch.row)) || newWindows.some(([, window]) => !isThisWindow(window.row))) {
      throw new ProofHold('proof-coverage-windows');
    }
    const accountIds = new Set([...before.coverage.keys(), ...after.coverage.keys()]);
    if ([...accountIds].some((id) => id !== account.id && !sameRanges(before.coverage.get(id), after.coverage.get(id)))) {
      throw new ProofHold('proof-coverage-other-account');
    }

    // I, the import's own rows (ROOT; Astra's conditions): those it inserted and the pending rows it posted, both read from
    // the validated BEFORE/AFTER state (G-ROWS passed, so every promotion is a D12 one, in the target). Never the request's.
    const importRows = new Set([...rows.appeared, ...rows.promoted]);
    const paymentsAfter = paymentsProjection(readCardPaymentReconciliation(repo, reader), [...after.accounts.keys()]);
    const payments = diffPayments(paymentsBefore, paymentsAfter, importRows, account.issuer);
    if (payments.code) throw new ProofHold(payments.code);
    const conflicts = paymentReconciliationReport(db).conflicts.total;
    if (conflicts !== 0) throw new ProofHold('proof-payments-conflicts');

    const storedAfter: LinkedRows = linksApplicable ? storedLinks(db) : new Map();
    const storedDiff = diffLinks(storedBefore, storedAfter);
    if (storedDiff.lost + storedDiff.moved + storedDiff.added > 0) throw new ProofHold('proof-links-stored');
    const projectedAfter: LinkedRows = linksApplicable ? projectedLinks(db, nowIso) : new Map();
    const projected = diffLinks(projectedBefore, projectedAfter);
    if (projected.lost + projected.moved > 0) throw new ProofHold('proof-links-projected');
    const drift = diffLinks(storedBefore, projectedBefore);

    const countsAfter = importTableCounts(db);
    // The cutover route adds exactly this job's cutover receipt, unless it answered with the stored one; the commit
    // route adds none. No other cutover receipt changes.
    const cutoverExpected = ctx.route === 'cutover' && applied.cutoverRepeated === false ? [request.jobId] : [];
    const cutoverAdded = [...after.cutoverReceipts.keys()].filter((id) => !before.cutoverReceipts.has(id));
    const cutoverChanged = [...before.cutoverReceipts].some(([id, digest]) => after.cutoverReceipts.get(id) !== digest)
      || (ctx.route === 'cutover') !== (applied.cutoverRepeated !== undefined)
      || cutoverAdded.length !== cutoverExpected.length || cutoverAdded.some((id, index) => id !== cutoverExpected[index]);
    // v1.1 §3.4: the tables an import writes grow by exactly what it did (cardLedger/writer.ts insertFileRows,
    // promoteFileRows, and the snapshot trigger): per inserted row an identity, an `inserted` content and a `created`
    // event; per D12 promotion a `promoted` content, a `promoted` event and the version kept of the pending row; one batch
    // and one window per committed import; no account.
    const imported = rows.appeared.length, promoted = rows.promoted.length;
    const expectedGrowth: Record<string, number> = {
      card_transactions: imported, card_import_batches: batchesAdded, card_coverage_windows: batchesAdded,
      card_source_identities: imported, card_identity_contents: imported + promoted, card_transaction_events: imported + promoted,
      card_transaction_versions: promoted, card_accounts: 0,
    };
    const tablesChanged = cutoverChanged || Object.keys(before.foreign).some((name) => before.foreign[name] !== after.foreign[name])
      || before.cardTables.size !== after.cardTables.size
      || [...before.cardTables].some(([name, digest]) => after.cardTables.get(name) !== digest)
      || Object.keys(countsBefore).some((name) => countsAfter[name] - countsBefore[name] !== expectedGrowth[name])
      || !ledgerIsThisImports(db, ledgerBefore, { accountId: account.id, batchId: newBatchId, appeared: new Set(rows.appeared),
        promoted: new Set(rows.promoted), revisions: new Map(rows.promoted.map((id) => [id, before.rows.get(id)?.row?.revision])) });
    if (tablesChanged) throw new ProofHold('proof-tables');

    const admission = checkAdmission(admissionBefore, evaluateAdmission(verifiers, db, account));
    if (admission.code) throw new ProofHold(admission.code);

    const categories = categoryEffects(categoriesBefore, effectiveCategories(repo), rows.promoted);

    // 5. F2: no commit lands after the client's deadline, nor without the permit it began under.
    if (ctx.now() >= request.deadlineMs) throw new ProofHold('proof-fence-expired');
    const permit = request.mode === 'automatic' ? checkLivePermit(db, account.issuer) : null;
    if (permit && (!permit.live || permit.globalGeneration !== permitAtStart?.globalGeneration
      || permit.issuerGeneration !== permitAtStart?.issuerGeneration)) {
      throw new ProofHold('proof-permit-dead');
    }

    const spanBefore = coverageSpan(coverageBefore)!, spanAfter = coverageSpan(coverageAfter)!;
    const receipt: ProofReceipt = {
      format: PROOF_FORMAT,
      version: 1,
      proofVersion: PROOF_VERSION,
      mode: request.mode,
      route: ctx.route,
      jobId: request.jobId,
      attempt: request.attempt,
      cardAccountId: account.id,
      payloadSha256: ctx.payloadSha256,
      planDigest: applied.planDigest,
      outcome: applied.outcome,
      counts: {
        rows: payload.rows.length, new: rows.appeared.length,
        duplicate: payload.rows.length - rows.appeared.length - rows.promoted.length - skipped.size,
        promoted: rows.promoted.length, contentTwinsSkipped: skipped.size, held: 0, review: 0,
      },
      statement: statement.status === 'match' ? 'match' : 'unchecked',
      statementPolicy: request.statementPolicy,
      completeness: { basis, interval: { from: payload.coverage.start, to: payload.coverage.end } },
      replay: { new: 0, possibleDuplicate: 0, reapply: 'nothing-new' },
      coverage: {
        payload: { from: payload.coverage.start, to: payload.coverage.end }, before: spanBefore, after: spanAfter, move: coverage.move,
      },
      rows: {
        appeared: rows.appeared.length, elsewhere: rows.elsewhere, gone: rows.gone, changed: rows.changed,
        promoted: rows.promoted.length, promotedTextChanged: rows.promotedTextChanged, promotedCategoryChanged: categories.promoted,
        categoryEffects: categories.all, inSpan: superset.inSpan, untwinned: superset.untwinned,
      },
      payments: {
        pairsBefore: payments.pairsBefore, pairsAfter: payments.pairsAfter, pairsAdded: payments.pairsAdded,
        pairsChangedOrGone: payments.pairsChangedOrGone, ambiguousBefore: payments.ambiguousBefore,
        ambiguousAfter: payments.ambiguousAfter, unmatchedPaymentsNew: payments.unmatchedPaymentsNew,
        unmatchedDebitsBefore: payments.unmatchedDebitsBefore, unmatchedDebitsAfter: payments.unmatchedDebitsAfter,
        reasonFlipsToNoCardPayment: payments.reasonFlipsToNoCardPayment, otherChanges: payments.otherChanges,
        returnedAdded: payments.returnedAdded, conflicts,
      },
      links: {
        applicable: linksApplicable, stored: storedAfter.size, lost: storedDiff.lost, moved: storedDiff.moved,
        added: storedDiff.added, projectedLost: projected.lost, projectedMoved: projected.moved,
        projectedAdded: projected.added, driftBefore: drift.lost + drift.moved + drift.added,
      },
      verifiers: admission.entries.map((entry) => ({
        id: entry.id, result: entry.after.result, reconciledThroughBefore: entry.before.reconciledThrough,
        reconciledThroughAfter: entry.after.reconciledThrough,
      })),
      tables: 'unchanged',
      permit: permit ? { globalGeneration: permit.globalGeneration, issuerGeneration: permit.issuerGeneration } : null,
      seal: null,
      timing: timingBucket(performance.now() - started),
      committedAt: new Date(ctx.now()).toISOString(),
    };
    try {
      assertProofReceipt(receipt);
    } catch (error) {
      if (error instanceof ProofReceiptInvalid) throw new ProofHold('proof-receipt-invalid');
      throw error;
    }
    db.prepare(`INSERT INTO ${PROOF_RECEIPTS_TABLE} (job_id, card_account_id, payload_sha256, receipt_json) VALUES (?, ?, ?, ?)`)
      .run(request.jobId, account.id, ctx.payloadSha256, serializeProofReceipt(receipt));
    return { receipt, repeated: false, applied };
  }).immediate();
}

export interface ResolveContext {
  db: Database;
  account: CardAccount;
  payloadSha256: string;
}

/**
 * The fence (design v1.1 §3.8). It raises the job's durable fence to at least `attempt`, then reads the receipt, in one
 * IMMEDIATE transaction.
 * - SQLite's write lock serializes it with every proof transaction, across processes.
 * - A transaction for that attempt (or an earlier one) that committed before it is seen here: committed.
 * - One that begins after it is refused at F1.
 * So "not-committed" is final.
 */
export function resolveProof(ctx: ResolveContext, request: ProofResolveRequest): ProofResolveResult {
  const { db } = ctx;
  return db.transaction((): ProofResolveResult => {
    requireSchema(db);
    const fence = readFence(db, request.jobId);
    sameJob(fence, ctx);
    if (!fence) {
      db.prepare(`INSERT INTO ${PROOF_FENCES_TABLE} (job_id, card_account_id, payload_sha256, max_resolved_attempt)
        VALUES (?, ?, ?, ?)`).run(request.jobId, ctx.account.id, ctx.payloadSha256, request.attempt);
    } else if (request.attempt > fence.maxResolvedAttempt) {
      db.prepare(`UPDATE ${PROOF_FENCES_TABLE} SET max_resolved_attempt = ? WHERE job_id = ?`).run(request.attempt, request.jobId);
    }
    const stored = readReceipt(db, request.jobId);
    sameJob(stored, ctx);
    return stored ? { outcome: 'committed', receipt: stored.receipt } : { outcome: 'not-committed' };
  }).immediate();
}
