import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cardExternalIdHash } from '@finance-tracker/shared';

import { CardSyncScenario, SCENARIO_OWNER } from '../../testing/cardSyncScenario.js';
import type { CardSourceBindingView } from '../sqliteStateRepo.js';
import { rowContentDigest } from '../cardSyncDigests.js';
import { CARD_SYNC_ADMISSIONS } from './admissions.js';
import { classify, type ClassifyContext, type PlanObservation } from './classify.js';
import { LedgerOverlay, LedgerView, type BankValues } from './ledgerView.js';
import { LEGACY_NAMESPACE } from './migrateV15.js';

// E1b design §4.4's v1 rules (E2d): a v1 row (a file observation in the account's legacy scope) is compared with
// near-content candidates only among rows the browser extension created; with none it is inserted as Phase 4 inserts
// it (never `unknown-scope`), and with some it is held for the owner as `cross-source-similar`.

let w: CardSyncScenario;
let binding: CardSourceBindingView;
let known: string[];
let legacy: string;
let synced: string;
let filed: string;

beforeEach(() => {
  w = new CardSyncScenario();
  w.enable('chase');
  binding = w.binding();
  const device = w.device([binding.bindingId]);
  ({ known } = w.scopes(binding));
  w.repo.importCardTransactions({ cardAccountId: binding.cardAccountRef, source: 'chase-csv', parserVersion: 'holdr-card-import@1.0.0',
    actorRef: SCENARIO_OWNER, rows: [{ externalIdHash: cardExternalIdHash('file-1'), transactionDate: '2026-10-05', postedDate: '2026-10-05',
      status: 'posted', currency: 'USD', amountMinor: 4200, kind: 'purchase', description: 'NORTHWIND TRADERS' }] });
  w.ingest(device, binding, [{ scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE', merchant: 'Fourth Coffee',
    id: 'sor-1' }]);
  legacy = w.db.prepare("SELECT id FROM card_scopes WHERE kind = 'legacy'").pluck().get() as string;
  synced = w.db.prepare('SELECT id FROM card_transactions WHERE first_sync_run_id IS NOT NULL').pluck().get() as string;
  filed = w.db.prepare('SELECT id FROM card_transactions WHERE first_sync_run_id IS NULL').pluck().get() as string;
});

afterEach(() => {
  w.close();
});

function fileRow(values: Partial<BankValues>, reference = 'file-new'): PlanObservation {
  const full: BankValues = { transactionDate: '2026-10-02', postedDate: '2026-10-02', status: 'posted', amountMinor: 1250,
    originalAmountMinor: null, originalCurrency: null, kind: 'purchase', description: 'FOURTH COFFEE #2', merchant: null, issuerCategory: null,
    ...values };
  return {
    ordinal: 0, id: 'card-obsrow-file', itemId: null, origin: 'file', scopeId: legacy, scopeKind: 'legacy',
    tuples: [{ scopeId: legacy, scopeKind: 'legacy', namespace: LEGACY_NAMESPACE, namespaceKind: 'legacy-file',
      idHash: cardExternalIdHash(reference) }],
    values: full, content: rowContentDigest(full),
  };
}

function context(): ClassifyContext {
  return { overlay: new LedgerOverlay(new LedgerView(w.db, binding.cardAccountRef, 'USD')), admissions: CARD_SYNC_ADMISSIONS,
    excluded: new Set(), knownScopes: new Set() };
}

describe('a v1 row against the ledger (§4.4 row 4, v1)', () => {
  it('is held as cross-source-similar near a row the extension created, offering a link, a new row or a rejection', () => {
    const result = classify(fileRow({}), context());
    expect(result).toMatchObject({ kind: 'review', reason: 'cross-source-similar', category: 'cross-source-similar',
      candidates: [expect.objectContaining({ transactionId: synced, rule: 'near-content:v1', blocked: null })] });
    // same-transaction (1) | insert-new (8) | reject-row (128): no attribution without a binding's known scopes.
    expect(result.kind === 'review' && result.allowed).toBe(137);
  });

  it('is held whatever the statuses: a pending v1 row near a posted synced one', () => {
    const result = classify(fileRow({ status: 'pending', postedDate: null, transactionDate: '2026-09-30' }), context());
    expect(result).toMatchObject({ kind: 'review', reason: 'cross-source-similar', candidates: [expect.objectContaining({ transactionId: synced })] });
  });

  it('is inserted when only file-created rows are near it (Phase 4 decides those) or nothing is', () => {
    expect(classify(fileRow({ amountMinor: 4200, transactionDate: '2026-10-05', postedDate: '2026-10-05', description: 'NORTHWIND' }), context()))
      .toMatchObject({ kind: 'insert' });
    expect(classify(fileRow({ amountMinor: 999 }), context())).toMatchObject({ kind: 'insert' });
  });

  it('is never held by a synced row outside the near-content window or removed', () => {
    expect(classify(fileRow({ transactionDate: '2026-10-09', postedDate: '2026-10-09' }), context())).toMatchObject({ kind: 'insert' });
    w.repo.removeCardTransaction({ id: synced, reason: 'mistaken-import', expectedRevision: 1, actorRef: SCENARIO_OWNER });
    expect(classify(fileRow({}), context())).toMatchObject({ kind: 'insert' });
  });

  it('leaves an extension row\'s candidates as they were: it still sees file-created rows', () => {
    const observation: PlanObservation = { ...fileRow({ amountMinor: 4200, transactionDate: '2026-10-06', postedDate: '2026-10-06',
      description: 'NORTHWIND TRADERS 2' }), origin: 'extension', scopeId: known[0], scopeKind: 'known',
    tuples: [{ scopeId: known[0], scopeKind: 'known', namespace: 'chase-api:sor:v1', namespaceKind: 'stable', idHash: cardExternalIdHash('x') }] };
    expect(classify(observation, context())).toMatchObject({ kind: 'review', candidates: [expect.objectContaining({ transactionId: filed })] });
  });
});
