/**
 * Assembling one capture (E3 review I4 and I5; normative rules in the
 * contract doc, section 10a). The incremental projected batches of one page
 * stream are merged into one batch, and an account's coverage is expanded to
 * the card scopes the account is bound to. Both are pure, and their results
 * go through the validators like any other message or payload.
 */
import { canonicalJson, type JsonValue } from './canonical.js';
import { CardSyncIssueList, cardSyncIndexPath, type CardSyncIssue, type CardSyncIssueCode } from './issues.js';
import {
  validateProjectedBankBatch,
  type ProjectedAccountCandidate,
  type ProjectedBankBatchV1,
  type ProjectedBankBatchValidation,
  type ProjectedCoverageEntry,
  type ProjectedTransaction,
} from './projectedBatch.js';
import { MAX_PAGE_COUNT, observedHull } from './wireChecks.js';
import type { CardSyncCoverageEntry, CardSyncDateRange, CardSyncRowV2 } from './wireV2.js';

/** Batches one merge takes: a capture reads at most 100 pages. */
export const PROJECTED_BATCH_MAX_MERGED = 100;

/** Fields every batch of one stream shares. */
const STREAM_FIELDS = ['type', 'contractVersion', 'issuer', 'contract', 'streamHandle', 'currency'] as const;

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
}

function refuse(code: CardSyncIssueCode, path: string): ProjectedBankBatchValidation {
  return { ok: false, issues: [{ code, path }] };
}

/** `$…` paths of one batch as paths into the merge's input array, `$[index]…`. */
function inBatch(index: number, issues: readonly CardSyncIssue[]): CardSyncIssue[] {
  return issues.map(({ code, path }) => ({ code, path: `${cardSyncIndexPath('$', index)}${path.slice(1)}` }));
}

function mergeValidated(input: readonly unknown[]): ProjectedBankBatchValidation {
  if (!Array.isArray(input) || input.length === 0) return refuse('wrong-type', '$');
  if (input.length > PROJECTED_BATCH_MAX_MERGED) return refuse('too-many-items', '$');
  const issues = new CardSyncIssueList();
  const counted: Array<{ index: number; batch: ProjectedBankBatchV1 }> = [];
  for (let index = 0; index < input.length; index += 1) {
    const result = validateProjectedBankBatch(input[index]);
    if (!result.ok) {
      for (const issue of inBatch(index, result.issues)) issues.add(issue.code, issue.path);
      continue;
    }
    const batch = result.batch;
    if (counted.length > 0) {
      const differing = STREAM_FIELDS.find((key) => batch[key] !== counted[0].batch[key]);
      if (differing) {
        issues.add('inconsistent', `${cardSyncIndexPath('$', index)}.${differing}`);
        continue;
      }
      // A repeated or stale message: already counted, or overtaken.
      if (batch.sequence <= counted[counted.length - 1].batch.sequence) continue;
    }
    counted.push({ index, batch });
  }
  if (issues.list.length > 0) return { ok: false, issues: issues.list };

  const accounts = new Map<string, ProjectedAccountCandidate>();
  const identities = new Map<string, ProjectedTransaction>();
  const transactions: ProjectedTransaction[] = [];
  const coverage = new Map<string, ProjectedCoverageEntry>();
  let rejectedCount = 0;
  for (const { index, batch } of counted) {
    const at = cardSyncIndexPath('$', index);
    batch.accounts.forEach((candidate, position) => {
      const known = accounts.get(candidate.ref);
      if (!known) accounts.set(candidate.ref, candidate);
      else if (!sameJson(known, candidate)) issues.add('identity-conflict', cardSyncIndexPath(`${at}.accounts`, position));
    });
    batch.transactions.forEach((row, position) => {
      if (row.externalIdHash !== null) {
        const identity = `${row.accountRef}\u0000${row.identityNamespace}\u0000${row.externalIdHash}`;
        const known = identities.get(identity);
        if (known) {
          // The same observation again is kept once; the same identity with other content stops the capture.
          if (!sameJson(known, row)) issues.add('identity-conflict', cardSyncIndexPath(`${at}.transactions`, position));
          return;
        }
        identities.set(identity, row);
      }
      transactions.push(row);
    });
    batch.coverage.forEach((entry, position) => {
      const key = `${entry.accountRef} ${entry.status}`;
      const known = coverage.get(key);
      if (!known) {
        coverage.set(key, entry);
        return;
      }
      const path = cardSyncIndexPath(`${at}.coverage`, position);
      if (!sameJson(known.requested, entry.requested)) {
        issues.add('inconsistent', `${path}.requested`);
        return;
      }
      const pageCount = known.pageCount + entry.pageCount;
      if (pageCount > MAX_PAGE_COUNT) {
        issues.add('out-of-range', `${path}.pageCount`);
        return;
      }
      // The latest entry decides termination and completeness; the latest observed range gives the basis.
      coverage.set(key, { ...entry, pageCount, observed: entry.observed ?? known.observed });
    });
    rejectedCount += batch.rejectedCount;
  }
  if (issues.list.length > 0) return { ok: false, issues: issues.list };

  const last = counted[counted.length - 1].batch;
  return validateProjectedBankBatch({
    type: last.type,
    contractVersion: last.contractVersion,
    issuer: last.issuer,
    contract: last.contract,
    streamHandle: last.streamHandle,
    sequence: last.sequence,
    observedAt: last.observedAt,
    currency: last.currency,
    accounts: [...accounts.values()],
    transactions,
    coverage: [...coverage.values()].map((entry) => ({
      ...entry,
      observed: observedFor(transactions.filter((row) => row.accountRef === entry.accountRef && row.status === entry.status), entry.observed),
    })),
    rejectedCount,
  });
}

/** `observed` for rows on the basis of `basisFrom`: their hull, the snapshot day itself, or null without rows. */
function observedFor(
  rows: ReadonlyArray<Pick<ProjectedTransaction, 'transactionDate' | 'postedDate'>>,
  basisFrom: CardSyncDateRange | null,
): CardSyncDateRange | null {
  if (rows.length === 0 || basisFrom === null) return null;
  if (basisFrom.dateBasis === 'observation') return { ...basisFrom };
  return observedHull(rows, basisFrom.dateBasis) ?? null;
}

/**
 * Merges the incremental projected batches of one stream, in arrival order,
 * into one batch:
 * - every batch validates on its own, and all share type, contract version,
 *   issuer, read contract, stream handle and currency;
 * - a batch whose sequence is not above the last one counted (a repeat or a
 *   stale message) is dropped;
 * - candidates are joined by `ref`; a repeated ref must be identical;
 * - transactions keep their order. A row whose identity (candidate,
 *   namespace, digest) was seen before is kept once when identical, and
 *   refuses the merge (`identity-conflict`) when not. Rows without a stable
 *   id are kept as sent: batches are incremental;
 * - coverage per (candidate, status): `pageCount` summed (at most 100),
 *   `requested` equal in every batch, termination and completeness from the
 *   last batch with that entry, `observed` recomputed from the merged rows;
 * - `sequence` and `observedAt` are the last counted batch's, and
 *   `rejectedCount` is the sum.
 * The merged batch is validated again, and that validation is the result.
 * Issues found while merging point into the input (`$[i]…`); issues of the
 * merged batch point into it (`$…`). Never throws.
 */
export function mergeProjectedBatches(batches: readonly unknown[]): ProjectedBankBatchValidation {
  try {
    return mergeValidated(batches);
  } catch {
    return refuse('unreadable', '$');
  }
}

/**
 * v2 coverage for the card scopes one bound account was read into: for each
 * scope, in the order given, one entry per account entry (that is, per
 * status), with `requested`, `pageCount`, termination and completeness
 * copied. `observed` is that scope's rows with that status on the account
 * entry's basis (their hull, or the snapshot day for an observation basis),
 * or null when the scope has none. `complete` stays allowed without rows. The
 * entries are checked when the payload is validated.
 */
export function expandCoverageToScopes(
  accountEntries: ReadonlyArray<Pick<ProjectedCoverageEntry, 'status' | 'requested' | 'observed' | 'completeness' | 'pageCount' | 'termination'>>,
  cardScopeIds: readonly string[],
  rows: ReadonlyArray<Pick<CardSyncRowV2, 'cardScopeId' | 'status' | 'transactionDate' | 'postedDate'>>,
): CardSyncCoverageEntry[] {
  const entries: CardSyncCoverageEntry[] = [];
  for (const cardScopeId of cardScopeIds) {
    for (const entry of accountEntries) {
      entries.push({
        cardScopeId,
        status: entry.status,
        requested: entry.requested === null ? null : { ...entry.requested },
        observed: observedFor(rows.filter((row) => row.cardScopeId === cardScopeId && row.status === entry.status), entry.observed),
        completeness: entry.completeness,
        pageCount: entry.pageCount,
        termination: entry.termination,
      });
    }
  }
  return entries;
}
