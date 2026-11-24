/**
 * Builds the `holdr.card-import` v2 payload for one account candidate of the
 * stream store, after the user confirmed the binding and the card scopes in
 * the extension's own popup (contract sections 10a and 15):
 *
 * - the account's batches are merged (`mergeProjectedBatches`, through the
 *   store); one candidate maps to one binding, and rows of other candidates
 *   stay in the page;
 * - every row's (holder group, card last four) pair must be mapped to a
 *   confirmed scope, possibly the binding's "holder unknown" scope;
 * - each row's text is prepared again with the payload's `cards` as hints
 *   (`prepareCardSyncRowText`); a row it cannot make safe is left out and
 *   counted as rejected;
 * - the account's coverage is expanded to every confirmed scope of the bound
 *   account (`confirmedScopes`, which the row map `scopes` must stay within),
 *   rows or not (`expandCoverageToScopes`; E1a §10a), never claiming
 *   `complete` with rejected rows;
 * - `owner` is null (Holdr knows the billing owner from the binding), `cards`
 *   the sorted last fours of the confirmed scopes, `statement` null;
 * - fingerprints and totals come from `buildCardSyncPayloadV2`, which also
 *   validates the whole payload. Nothing is truncated.
 */
import {
  CARD_IMPORT_NO_DESCRIPTION,
  CARD_SYNC_CONTRACT_VERSION,
  buildCardSyncPayloadV2,
  expandCoverageToScopes,
  prepareCardSyncRowText,
  type CardSyncIssue,
  type CardSyncIssuer,
  type CardSyncMode,
  type CardSyncPayloadV2,
  type CardSyncRowDraftV2,
  type CardSyncSource,
} from '@finance-tracker/shared';
import type { ScopeEntry } from '../contracts/messages.js';
import type { StreamStore } from './streamStore.js';

export interface BuildPayloadInput {
  store: StreamStore;
  accountRef: string;
  captureId: string;
  bindingId: string;
  bindingVersion: number;
  scopes: readonly ScopeEntry[];
  /** Every confirmed scope of the bound account; coverage covers each of them, rows or not (E1a §10a). */
  confirmedScopes: readonly string[];
  cards: readonly string[];
  issuer: CardSyncIssuer;
  source: CardSyncSource;
  mode: CardSyncMode;
  parserVersion: string;
}

export type BuildPayloadResult =
  | { ok: true; payload: CardSyncPayloadV2; byteLength: number }
  | { ok: false; code: 'unknown-account' | 'identity-conflict' | 'unmapped-rows' | 'no-rows' | 'payload-refused'; issues: CardSyncIssue[] };

function pairKey(holderRef: string | null, cardLast4: string | null): string {
  return `${holderRef ?? '-'} ${cardLast4 ?? '-'}`;
}

export function buildPayload(input: BuildPayloadInput): BuildPayloadResult {
  if (!input.store.hasAccount(input.accountRef)) return { ok: false, code: 'unknown-account', issues: [] };
  if (input.store.conflicted) return { ok: false, code: 'identity-conflict', issues: [] };
  const merged = input.store.mergedFor(input.accountRef);
  if (!merged) return { ok: false, code: 'no-rows', issues: [] };
  if (!merged.ok) {
    const conflict = merged.issues.some((issue) => issue.code === 'identity-conflict');
    return { ok: false, code: conflict ? 'identity-conflict' : 'payload-refused', issues: merged.issues };
  }
  const batch = merged.batch;
  const accountRows = batch.transactions.filter((row) => row.accountRef === input.accountRef);
  const accountCoverage = batch.coverage.filter((entry) => entry.accountRef === input.accountRef);
  if (accountCoverage.length === 0) return { ok: false, code: 'no-rows', issues: [] };

  const scopeOf = new Map<string, string>();
  const confirmed = new Set(input.confirmedScopes);
  for (const entry of input.scopes) {
    const key = pairKey(entry.holderRef, entry.cardLast4);
    if (scopeOf.has(key) && scopeOf.get(key) !== entry.cardScopeId) return { ok: false, code: 'unmapped-rows', issues: [] };
    // A row group maps only to a confirmed scope of the bound account.
    if (!confirmed.has(entry.cardScopeId)) return { ok: false, code: 'unmapped-rows', issues: [] };
    scopeOf.set(key, entry.cardScopeId);
  }

  const cards = [...new Set(input.cards)].sort();
  const rows: CardSyncRowDraftV2[] = [];
  let leftOut = 0;
  for (const row of accountRows) {
    const cardScopeId = scopeOf.get(pairKey(row.holderRef, row.cardLast4));
    if (!cardScopeId) return { ok: false, code: 'unmapped-rows', issues: [] };
    const text = prepareCardSyncRowText({ description: row.description, merchant: row.merchant, issuerCategory: row.issuerCategory }, { hints: cards });
    if (!text.ok) {
      leftOut += 1;
      continue;
    }
    rows.push({
      transactionDate: row.transactionDate,
      postedDate: row.postedDate,
      status: row.status,
      amountMinor: row.amountMinor,
      kind: row.kind,
      description: text.description || CARD_IMPORT_NO_DESCRIPTION,
      merchant: text.merchant || null,
      issuerCategory: text.issuerCategory || null,
      externalIdHash: row.externalIdHash,
      cardScopeId,
      identityNamespace: row.identityNamespace,
      secondaryIds: row.secondaryIds.map((secondary) => ({ namespace: secondary.namespace, idHash: secondary.idHash })),
      originalAmountMinor: row.originalAmountMinor,
      originalCurrency: row.originalCurrency,
    });
  }

  const rejectedCount = batch.rejectedCount + leftOut;
  const scopeIds = [...confirmed].sort();
  const accountEntries = accountCoverage.map((entry) => ({
    ...entry,
    completeness: rejectedCount > 0 && entry.completeness === 'complete' ? ('partial' as const) : entry.completeness,
  }));
  const coverage = expandCoverageToScopes(accountEntries, scopeIds, rows);

  const result = buildCardSyncPayloadV2({
    contractVersion: CARD_SYNC_CONTRACT_VERSION,
    source: input.source,
    parserVersion: input.parserVersion,
    issuer: input.issuer,
    currency: 'USD',
    owner: null,
    cards,
    bindingId: input.bindingId,
    bindingVersion: input.bindingVersion,
    captureId: input.captureId,
    observedAt: batch.observedAt,
    mode: input.mode,
    coverage,
    rejectedCount,
    statement: null,
    rows,
  });
  if (!result.ok) return { ok: false, code: 'payload-refused', issues: result.issues };
  return { ok: true, payload: result.payload, byteLength: result.byteLength };
}
