import type { Database as DB } from 'better-sqlite3';
import { CARD_SYNC_ISSUERS } from '@finance-tracker/shared';

import { NO_ADMISSIONS } from '../cardLedger/admissions.js';
import { classify, type ClassifyContext, type PlanObservation, type ReviewClassification, type ReviewReason } from '../cardLedger/classify.js';
import { LedgerOverlay, LedgerView, type BankValues } from '../cardLedger/ledgerView.js';
import { LEGACY_NAMESPACE } from '../cardLedger/migrateV15.js';
import type { LegacyHit } from '../cardLedger/writer.js';
import { insertRows } from '../cardSync/bulk.js';
import { insertItems } from '../cardSync/items.js';
import { cardSyncHash, newCardSyncId, newCardSyncRowId, rowContentDigest } from '../cardSyncDigests.js';
import type { CardSyncStatements } from '../cardSyncStatements.js';
import type { ImportPlan } from './plan.js';

/**
 * A v1 import's review work (E1b design §4.10.4, §4.11; E2d): what a v1 file
 * leaves for its owner, decided inside the import's transaction by one pass
 * over its rows in file order.
 *
 * Phase 4's plan decides each row's v14 outcome (new, duplicate, promotion,
 * the owner's questions). The pass keeps it, except where §4.11 and the
 * review findings say otherwise:
 *
 * - **held**: not applied until the owner decides, counted in the batch's
 *   `rejected_count` and reported as `heldCount`:
 *   - a row the import would insert whose only near-content candidates are
 *     live rows with sync provenance (§4.4 row 4, v1; synced by a browser,
 *     or carrying a browser's identity whoever created them:
 *     LedgerView.syncProvenance);
 *   - a promotion whose final values have such a posted row near them, which
 *     may be the same purchase (E2d review r1, finding 2);
 * - **review**: the ledger is untouched, the row stays a duplicate, and one
 *   item asks the owner:
 *   - a stored key with content its identity doesn't know: E-Q7, for every
 *     row whatever its source (`posted-correction`, `pending-changed`,
 *     `removed-hit`; finding 3);
 *   - a key whose identity the owner detached (`detached-identity`; finding 4);
 *   - a second key of a row the same import writes, with other values
 *     (finding 6). With the same values it is unchanged, and its content is
 *     remembered.
 *
 * Each (key, content) is asked about once: an open file row of a live set
 * that already asks about it is enough (the row is then a duplicate). An open
 * row of a set past its deadline is expired here, with its item and the set's
 * `touch-set`, so the new row takes its place (§4.10.4's due rows). Rows
 * named by an active identity of the file's keys are never candidates (§4.4);
 * a detached key's old row is.
 *
 * Only a card account of an issuer the browser extension syncs has file sets
 * (`ck_set_issuer`; E2d-D22). On any other issuer's account the pass holds and
 * asks nothing: every row keeps Phase 4's outcome, as in v14 (`fileReviewIssuer`).
 */

/**
 * Whether a card account's issuer can have file review sets: the sync issuers, which `card_sync_observation_sets.issuer`
 * (`ck_set_issuer`, design §2.8) allows. Another issuer's account can't have sync provenance either: a binding needs a
 * registered source of the account's own issuer (`card_sync_sources.issuer`, the same four), and only a binding creates
 * the known and unknown scopes a browser's identity or row needs (E2d-D22).
 */
export const fileReviewIssuer = (issuer: string): boolean => (CARD_SYNC_ISSUERS as readonly string[]).includes(issuer);

/** A v1 row as the import keyed it. */
export interface FileReviewRow {
  /** Its index in the v1 payload: the observation's `file_row_index`. */
  index: number;
  /** Its v1 key: the issuer reference's `xid1:` or the fingerprint (`cfp1:`, with the occurrence the import gave it). */
  key: string;
  /** Whether the key is an issuer reference (`external_id_hash`) or a fingerprint. */
  byReference: boolean;
  values: BankValues;
}

/** An open file row asking about the same key and content, in a set past its deadline. */
interface DueFileRow {
  observationId: string;
  setId: string;
}

export interface FileReviewEntry {
  row: FileReviewRow;
  observation: PlanObservation;
  review: ReviewClassification;
  /** The due open row this one replaces, or null. */
  replaces: DueFileRow | null;
}

/**
 * Phase 4's outcome for a row once the owner's decisions apply: the pass starts from it. `question` is a row that waits
 * for the owner's answer (a preview's possible duplicates and pending or dismissed matches): never classified, but the row
 * its key names is still no other row's candidate.
 */
export type FileRowOutcome = 'insert' | 'promote' | 'duplicate' | 'question';

/** A row of the file as the pass reads it, in file order. */
export interface FileReviewInput extends FileReviewRow {
  outcome: FileRowOutcome;
  /** The stored row and identity the row's key names (active or detached), or null. */
  hit: LegacyHit | null;
  /** The key repeats an earlier row of the file: Phase 4's duplicate, never asked about. */
  repeated: boolean;
  /** Inserted on the owner's word (`possibleDuplicates=import`): never held. */
  exempt: boolean;
}

export interface FileReviewWork {
  /** Rows not applied until the owner decides (new items): inserts held and promotions withheld. */
  held: FileReviewEntry[];
  /** File positions of rows that would be held but whose review is open in a live set already: duplicates. */
  heldOpen: number[];
  /** Duplicates the owner is asked about (new items; the ledger is untouched). */
  review: FileReviewEntry[];
  /** File positions of the rows inserted. */
  inserted: number[];
  /** The promotions applied: at most one per canonical row (finding 6). */
  promoted: FileReviewInput[];
  /** Later keys of a row the import writes, with the values it writes: unchanged, their content remembered (finding 6). */
  remembered: Array<{ identityId: string; values: BankValues }>;
}

/** The identity-hit reasons a duplicate brings to the owner (§4.11 E-Q7 and removed hits; a detached key, §4.4). */
const REVIEW_REASONS: ReadonlySet<ReviewReason> = new Set(['posted-correction', 'pending-changed', 'removed-hit', 'detached-identity']);

/** A v1 row as the classifier sees it: the legacy scope and namespace, its key as the id (§4.1). */
export function fileObservation(row: FileReviewRow, legacyScopeId: string): PlanObservation {
  return {
    ordinal: row.index, id: `file-row-${row.index}`, itemId: null, origin: 'file', scopeId: legacyScopeId, scopeKind: 'legacy',
    tuples: [{ scopeId: legacyScopeId, scopeKind: 'legacy', namespace: LEGACY_NAMESPACE, namespaceKind: 'legacy-file', idHash: row.key }],
    values: row.values, content: rowContentDigest(row.values),
  };
}

/** Amounts of live rows with sync provenance, read through the per-scope index prefix (see LedgerView.syncProvenance). */
function provenanceAmounts(db: DB, account: { id: string; currency: string }): Set<number> {
  return new Set(db.prepare(`SELECT amount_minor FROM card_transactions WHERE card_account_id = ? AND currency = ?
      AND first_sync_run_id IS NOT NULL AND status IN ('pending', 'posted')
    UNION SELECT t.amount_minor FROM card_scopes s
      JOIN card_source_identities i ON i.card_account_id = s.card_account_id AND i.source_scope_id = s.id
      JOIN card_transactions t ON t.id = i.canonical_transaction_id
    WHERE s.card_account_id = ? AND s.kind <> 'legacy' AND i.status = 'active' AND t.currency = ? AND t.status IN ('pending', 'posted')`)
    .pluck().all(account.id, account.currency, account.id, account.currency) as number[]);
}

/**
 * The review work of one v1 import, read in its transaction: one pass over
 * `rows` in file order, against the ledger as the earlier rows of the file
 * leave it (an overlay of the promotions it applies). Reads only.
 */
export function fileReviewWork(db: DB, now: string, input: {
  account: { id: string; issuer: string; currency: string };
  legacyScopeId: string;
  rows: readonly FileReviewInput[];
}): FileReviewWork {
  const { account } = input;
  const work: FileReviewWork = { held: [], heldOpen: [], review: [], inserted: [], promoted: [], remembered: [] };
  // Rows the file's keys name through an active identity are never candidates (§4.4); a detached key's old row is.
  const excluded = new Set(input.rows.flatMap((row) => (row.hit && row.hit.identityStatus === 'active' ? [row.hit.transactionId] : [])));
  let amounts: Set<number> | undefined;
  // An account of another issuer than the extension's keeps Phase 4's outcome for every row (E2d-D22): no file set can
  // hold its review work.
  const fileSets = fileReviewIssuer(account.issuer);
  // Only amounts some live row with sync provenance has can be held: most files, and every file of an account the
  // extension never synced, skip the classifier for their new rows and promotions entirely.
  const holdable = (values: BankValues) => fileSets && (amounts ??= provenanceAmounts(db, account)).has(values.amountMinor);
  const view = new LedgerView(db, account.id, account.currency);
  // Canonical rows the file writes, with the values written: one write per row (finding 6).
  const written = new Map<string, { values: BankValues; identityId: string }>();
  let context: ClassifyContext | undefined;
  const write = (c: ClassifyContext, target: string, values: BankValues, identityId: string) => {
    const before = c.overlay.row(target);
    if (before) {
      c.overlay.setRow({ ...before, revision: before.revision + 1, status: values.status, transactionDate: values.transactionDate,
        postedDate: values.postedDate, amountMinor: values.amountMinor, originalAmountMinor: values.originalAmountMinor,
        originalCurrency: values.originalCurrency, kind: values.kind, description: values.description, merchant: values.merchant,
        issuerCategory: values.issuerCategory, removedReason: null, removedFromStatus: null });
    }
    c.overlay.remember(identityId, rowContentDigest(values));
  };
  const ctx = (): ClassifyContext => {
    if (!context) {
      // A file set has no binding, so no known scope to attribute to (§4.6): links, new rows and rejections only.
      context = { overlay: new LedgerOverlay(view), admissions: NO_ADMISSIONS, excluded, knownScopes: new Set() };
      for (const [target, { values, identityId }] of written) write(context, target, values, identityId);
    }
    return context;
  };
  const openRow = db.prepare(`SELECT o.id AS observationId, o.observation_set_id AS setId, s.expires_at AS expiresAt
      FROM card_source_observations o JOIN card_sync_observation_sets s ON s.id = o.observation_set_id
     WHERE o.card_account_id = ? AND o.source_scope_id = ? AND o.identity_namespace = ? AND o.identity_hash = ? AND o.content_digest = ?
       AND o.origin = 'file' AND o.state = 'open'`);
  const entry = (row: FileReviewRow, review: ReviewClassification, observation: PlanObservation): FileReviewEntry | 'open' => {
    const open = openRow.get(account.id, input.legacyScopeId, LEGACY_NAMESPACE, row.key, observation.content) as
      (DueFileRow & { expiresAt: string }) | undefined;
    if (open && now < open.expiresAt) return 'open';
    return { row, observation, review, replaces: open ? { observationId: open.observationId, setId: open.setId } : null };
  };
  /**
   * Asks about a duplicate when the classifier has a review for it (an open one is asked already). A removed row's hit
   * with posted rows near it comes as `cross-source-similar` (the rival-aware removed hit, r2 finding 2) and is asked too.
   */
  const ask = (row: FileReviewRow) => {
    if (!fileSets) return;
    const observation = fileObservation(row, input.legacyScopeId);
    const classified = classify(observation, ctx());
    if (classified.kind !== 'review') return;
    if (!REVIEW_REASONS.has(classified.reason)
      && !(classified.reason === 'cross-source-similar' && classified.row?.status === 'removed')) return;
    const reviewed = entry(row, classified, observation);
    if (reviewed !== 'open') work.review.push(reviewed);
  };
  const hold = (row: FileReviewRow, review: ReviewClassification, observation: PlanObservation) => {
    const held = entry(row, review, observation);
    if (held === 'open') work.heldOpen.push(row.index);
    else work.held.push(held);
  };

  for (const row of input.rows) {
    if (row.outcome === 'question') continue;
    if (row.outcome === 'insert') {
      if (row.exempt || !holdable(row.values)) {
        work.inserted.push(row.index);
        continue;
      }
      const observation = fileObservation(row, input.legacyScopeId);
      const classified = classify(observation, ctx());
      if (classified.kind === 'review') hold(row, classified, observation);
      else work.inserted.push(row.index);
      continue;
    }
    const hit = row.hit;
    if (row.repeated || !hit) continue;
    const earlier = written.get(hit.transactionId);
    if (earlier) {
      // A second key of a row the file already writes: the same values are the same news, other values are asked about
      // against the row as the earlier key leaves it (finding 6).
      if (rowContentDigest(earlier.values) === rowContentDigest(row.values)) {
        if (hit.identityStatus === 'active') work.remembered.push({ identityId: hit.identityId, values: row.values });
      } else {
        ask(row);
      }
      continue;
    }
    if (row.outcome === 'promote') {
      if (holdable(row.values)) {
        const observation = fileObservation(row, input.legacyScopeId);
        const classified = classify(observation, ctx());
        if (classified.kind === 'review' && classified.reason === 'cross-source-similar') {
          hold(row, classified, observation);
          continue;
        }
      }
      work.promoted.push(row);
      written.set(hit.transactionId, { values: row.values, identityId: hit.identityId });
      if (context) write(context, hit.transactionId, row.values, hit.identityId);
      continue;
    }
    // A duplicate. A detached key comes back to the owner (finding 4); a dismissed or v14-removed row stays Phase 4's
    // duplicate (§4.11, A19); content the key's identity knows is a replay; anything else is E-Q7's (finding 3).
    if (hit.identityStatus !== 'active') {
      ask(row);
      continue;
    }
    if (hit.status === 'removed' && (hit.removedReason === 'dismissed' || hit.removedReason === 'legacy')) continue;
    if (view.knowsContent(hit.identityId, rowContentDigest(row.values))) continue;
    ask(row);
  }
  return work;
}

const SET_COLUMNS = ['id', 'origin', 'card_account_id', 'issuer', 'currency', 'import_batch_id', 'file_chunk', 'source', 'parser_version',
  'guard_revision', 'accepted_at', 'expires_at', 'state', 'version', 'review_ledger_revision', 'row_count', 'byte_count',
  'producer_rejected_count', 'statement_present', 'open_count', 'receipt_state'] as const;
const OBSERVATION_COLUMNS = ['id', 'observation_set_id', 'origin', 'card_account_id', 'ordinal', 'file_row_index', 'source_scope_id',
  'source_scope_kind', 'identity_namespace', 'namespace_kind', 'external_id_hash', 'fingerprint', 'identity_hash', 'transaction_date',
  'posted_date', 'status', 'amount_minor', 'currency', 'original_amount_minor', 'original_currency', 'kind', 'description', 'merchant',
  'issuer_category', 'content_digest'] as const;
/** Rows per file set (`file_chunk` 0–4 covers v1's 10,000-row limit, §4.10.3). */
const FILE_SET_ROWS = 2000;
const DAY_MS = 86_400_000;

/**
 * Stores the review work of an import as its file sets, after its batch: the
 * due rows they replace expired first (each with its item, and `touch-set`
 * once per set), then sets of at most 2,000 rows in payload order, each
 * `needs-review` with one open item per row and its candidates. The sets
 * record the ledger revision the classification read, so a set whose import
 * also changed the ledger is refreshed before it is shown (§4.5). Returns the
 * number of items stored.
 */
export function persistFileReviewSets(db: DB, now: string, statements: CardSyncStatements, input: {
  account: { id: string; issuer: string; currency: string };
  batchId: string;
  source: string;
  parserVersion: string;
  guardRevision: number;
  ledgerRevision: number;
  reviewRetentionDays: number;
  entries: readonly FileReviewEntry[];
}): number {
  const { account, entries } = input;
  if (entries.length === 0) return 0;
  const expireRow = db.prepare("UPDATE card_source_observations SET state = 'expired', resolved_at = ? WHERE id = ? AND state = 'open'");
  const expireItem = db.prepare(`UPDATE card_reconciliation_suggestions SET status = 'expired', draft_action = NULL, draft_transaction_id = NULL,
      draft_scope_id = NULL, drafted_by_ref = NULL, drafted_at = NULL, updated_at = ? WHERE observation_id = ? AND status IN ('open', 'decided')`);
  const touched = new Set<string>();
  for (const { replaces } of entries) {
    if (replaces === null) continue;
    expireRow.run(now, replaces.observationId);
    expireItem.run(now, replaces.observationId);
    touched.add(replaces.setId);
  }
  for (const setId of touched) statements.run('touch-set', { set_id: setId });

  const expiresAt = new Date(Date.parse(now) + input.reviewRetentionDays * DAY_MS).toISOString();
  const ordered = [...entries].sort((a, b) => a.row.index - b.row.index);
  for (let chunk = 0; chunk * FILE_SET_ROWS < ordered.length; chunk += 1) {
    const rows = ordered.slice(chunk * FILE_SET_ROWS, (chunk + 1) * FILE_SET_ROWS);
    const setId = newCardSyncId('obs_');
    insertRows(db, 'card_sync_observation_sets', SET_COLUMNS, [[setId, 'file', account.id, account.issuer, account.currency, input.batchId,
      chunk, input.source, input.parserVersion, input.guardRevision, now, expiresAt, 'needs-review', 1, input.ledgerRevision, rows.length,
      0, 0, 0, rows.length, 'none']]);
    const observationIds = rows.map(() => newCardSyncRowId('card-obsrow-'));
    insertRows(db, 'card_source_observations', OBSERVATION_COLUMNS, rows.map(({ row, observation }, ordinal) => {
      const values = row.values;
      return [observationIds[ordinal], setId, 'file', account.id, ordinal, row.index, observation.scopeId, 'legacy', LEGACY_NAMESPACE,
        'legacy-file', row.byReference ? row.key : null, row.byReference ? null : row.key, row.key, values.transactionDate, values.postedDate,
        values.status, values.amountMinor, account.currency, values.originalAmountMinor, values.originalCurrency, values.kind,
        values.description, values.merchant, values.issuerCategory, observation.content];
    }));
    insertItems(db, now, { id: setId, card_account_id: account.id }, rows.map(({ review }, ordinal) => ({
      observationId: observationIds[ordinal], review, statement: null,
    })), input.ledgerRevision);
  }
  return entries.length;
}

/**
 * `ipv1:` + H(...): what a v1 import's preview showed and what its commit would do (§5.7: the `previewDigest` the web
 * client may echo to the commit; E2d review r1, finding 1):
 * - the card account and the canonical payload;
 * - the account's ledger revision (any change to the ledger since makes it stale) and whether the coverage is covered;
 * - Phase 4's outcome per row, its reference conflicts, its pending matches with their stored rows and twins, its stale
 *   pending rows;
 * - every row the pass inserts, promotes (with the row and revision it targets), holds or asks about, with reasons and
 *   candidates.
 * Equal digests mean the commit would read the same ledger and do the same.
 */
export function cardImportPreviewDigest(input: {
  accountId: string; payloadJson: string; ledgerRevision: number; covered: boolean; plan: ImportPlan; work: FileReviewWork;
}): string {
  const { plan, work } = input;
  const reviewed = (entry: FileReviewEntry) => [entry.row.index, entry.review.reason, entry.review.allowed,
    entry.review.candidates.map((candidate) => [candidate.transactionId, candidate.rule, candidate.blocked])];
  return `ipv1:${cardSyncHash(['holdr.card-import-preview', 2, input.accountId, cardSyncHash(['holdr.card-import-payload', 1,
    input.payloadJson]), input.ledgerRevision, input.covered, plan.rows, plan.conflicts,
    plan.matches.map((match) => [match.index, match.stored.id, match.twins.map((twin) => twin.id), match.twinsInFile]),
    plan.stale.map((row) => row.id), work.inserted,
    work.promoted.map((row) => [row.index, row.hit?.transactionId ?? null, row.hit?.revision ?? null]),
    work.held.map(reviewed), work.heldOpen, work.review.map(reviewed),
    work.remembered.map((alias) => [alias.identityId, rowContentDigest(alias.values)])])}`;
}
