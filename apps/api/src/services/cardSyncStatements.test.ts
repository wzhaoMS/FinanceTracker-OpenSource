import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { cardExternalIdHash } from '@finance-tracker/shared';
import { CardSyncFixtures, type CardSyncGraph, type CardSyncPairingEnd } from '../testing/cardSyncFixtures.js';
import { CARD_SYNC_QUERIES, type CardSyncQueryName } from './cardSyncSchemaSql.js';
import { CARD_SYNC_WRITE_STATEMENTS, CardSyncStatements } from './cardSyncStatements.js';
import {
  CARD_REPORTS_V14_SCHEMA_FOR_TESTS,
  CARD_SPENDING_V13_SCHEMA_FOR_TESTS,
  SqliteStateRepo,
} from './sqliteStateRepo.js';

// Card-sync schema v15 (E1b): the 22 named statements of design §5.3.1, as
// later slices call them, on the repository's own (guarded) connection. The
// validator's probes (cardSyncSchema.probes.test.ts) run each against the
// constraints; these tests pin the module: what it prepares, how it is typed,
// what each write changes and leaves alone, and the index plans the design
// requires.

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(T0 + ms).toISOString();

let repo: SqliteStateRepo;
let db: Database.Database;
let statements: CardSyncStatements;
let fx: CardSyncFixtures;
let g: CardSyncGraph;
let accountId: string;

beforeEach(() => {
  repo = new SqliteStateRepo({ file: ':memory:', now: () => new Date(T0) });
  db = repo.internalGetDb();
  statements = new CardSyncStatements(db);
  accountId = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '3391', currency: 'USD' }).id;
  fx = new CardSyncFixtures(db, T0);
  g = fx.graph(accountId);
});

afterEach(() => {
  repo.close();
});

const row = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T;

type Grant = {
  status: string; revoked_at: string | null; auto_sync: number; consent_contract_version: number | null;
  consent_guard_revision: number | null; consent_issuer_revision: number | null; consent_binding_version: number | null;
  consent_by_ref: string | null; consent_at: string | null;
};
const grant = (id: string) => row<Grant>(`SELECT status, revoked_at, auto_sync, consent_contract_version, consent_guard_revision,
  consent_issuer_revision, consent_binding_version, consent_by_ref, consent_at FROM card_sync_device_scopes WHERE id = ?`, id);
const NO_CONSENT = {
  auto_sync: 0, consent_contract_version: null, consent_guard_revision: null, consent_issuer_revision: null,
  consent_binding_version: null, consent_by_ref: null, consent_at: null,
};

describe('CardSyncStatements: preparation', () => {
  it('prepares the design\'s 22 statements, writers and readers classified as SQLite classifies them', () => {
    const names = Object.keys(CARD_SYNC_QUERIES) as CardSyncQueryName[];
    expect(names).toHaveLength(22);
    const writers = names.filter((name) => !db.prepare(CARD_SYNC_QUERIES[name]).reader);
    expect(writers.sort()).toEqual([...CARD_SYNC_WRITE_STATEMENTS].sort());
    expect(CARD_SYNC_WRITE_STATEMENTS).toHaveLength(12);
  });

  it('refuses to prepare on a database without schema v15', () => {
    const v14 = new Database(':memory:');
    v14.exec(CARD_SPENDING_V13_SCHEMA_FOR_TESTS);
    v14.exec(CARD_REPORTS_V14_SCHEMA_FOR_TESTS);
    expect(() => new CardSyncStatements(v14)).toThrow(/no such table/);
    v14.close();
  });

  it('keeps close-pairing-of-device exactly as approved, its `status = \'redeemed\'` condition included', () => {
    expect(CARD_SYNC_QUERIES['close-pairing-of-device']).toBe([
      'UPDATE card_sync_pairings',
      "   SET status = 'cancelled', closed_at = :now",
      " WHERE status = 'redeemed'",
      '   AND id = (SELECT d.pairing_id FROM card_sync_devices d WHERE d.id = :device_id)',
      '',
    ].join('\n'));
  });
});

describe('CardSyncStatements: close-pairing-of-device', () => {
  const pairing = (id: string) => row<{ status: string; closed_at: string | null }>(
    'SELECT status, closed_at FROM card_sync_pairings WHERE id = ?', id);

  it('closes a revoked pending device\'s redeemed invitation and leaves every closed pairing as it was', () => {
    const ends: CardSyncPairingEnd[] = ['redeemed', 'approved', 'rejected', 'expired', 'cancelled'];
    const made = ends.map((end) => ({ end, ...fx.pairedDevice(g, end) }));
    const before = new Map(made.map(({ pairingId }) => [pairingId, pairing(pairingId)]));
    const now = iso(300_000);
    const pending = made[0];
    db.prepare("UPDATE card_sync_devices SET status = 'revoked', token_digest = NULL, closed_at = ?, close_reason = 'password-reset' WHERE id = ?")
      .run(now, pending.deviceId);

    const changes = made.map(({ deviceId }) => statements.run('close-pairing-of-device', { now, device_id: deviceId }));

    expect(changes).toEqual([1, 0, 0, 0, 0]);
    expect(pairing(pending.pairingId)).toEqual({ status: 'cancelled', closed_at: now });
    for (const { end, pairingId } of made.slice(1)) {
      expect(pairing(pairingId), end).toEqual(before.get(pairingId));
    }
    expect(statements.run('close-pairing-of-device', { now: iso(400_000), device_id: pending.deviceId }), 'again').toBe(0);
    expect(pairing(pending.pairingId)).toEqual({ status: 'cancelled', closed_at: now });
    expect(statements.run('close-pairing-of-device', { now, device_id: fx.id('dev_') }), 'no such device').toBe(0);
  });

  it('is load-bearing: without its status condition, revoking an approved device would abort on its closed pairing', () => {
    const { deviceId } = fx.pairedDevice(g, 'approved');
    const unconditional = CARD_SYNC_QUERIES['close-pairing-of-device'].replace("WHERE status = 'redeemed'\n   AND ", 'WHERE ');
    expect(unconditional).not.toBe(CARD_SYNC_QUERIES['close-pairing-of-device']);
    expect(() => db.prepare(unconditional).run({ now: iso(300_000), device_id: deviceId }))
      .toThrow('card invariant: a closed pairing never changes');
    expect(statements.run('close-pairing-of-device', { now: iso(300_000), device_id: deviceId })).toBe(0);
  });
});

describe('CardSyncStatements: grants give up their consent in the same UPDATE', () => {
  let d1: string;
  let d2: string;
  let consenting: string;
  let plain: string;
  let revoked: string;
  const NOW = iso(DAY_MS);

  beforeEach(() => {
    d1 = fx.pairedDevice(g, 'approved').deviceId;
    d2 = fx.pairedDevice(g, 'approved').deviceId;
    revoked = fx.grant(g, d1);
    statements.run('revoke-grant', { now: iso(1_000), grant_id: revoked });
    consenting = fx.grant(g, d1, { consent: true });
    plain = fx.grant(g, d2);
  });

  const revokedAt = (now: string) => ({ status: 'revoked', revoked_at: now, ...NO_CONSENT });
  const untouchedRevoked = () => expect(grant(revoked)).toEqual({ status: 'revoked', revoked_at: iso(1_000), ...NO_CONSENT });

  it('refuses a status-only revoke of a consenting grant (ck_dscope_consent_shape)', () => {
    expect(() => db.prepare("UPDATE card_sync_device_scopes SET status = 'revoked', revoked_at = ? WHERE id = ?").run(NOW, consenting))
      .toThrow('CHECK constraint failed: ck_dscope_consent_shape');
  });

  it('revoke-grants-of-device: the device\'s active grants only', () => {
    expect(statements.run('revoke-grants-of-device', { now: NOW, device_id: d1 })).toBe(1);
    expect(grant(consenting)).toEqual(revokedAt(NOW));
    expect(grant(plain).status).toBe('active');
    untouchedRevoked();
  });

  it('revoke-grants-of-binding: every active grant of the binding', () => {
    expect(statements.run('revoke-grants-of-binding', { now: NOW, binding_id: g.bindingId })).toBe(2);
    expect(grant(consenting)).toEqual(revokedAt(NOW));
    expect(grant(plain)).toEqual(revokedAt(NOW));
    untouchedRevoked();
  });

  it('revoke-grant: one active grant; a revoked one is left alone', () => {
    expect(statements.run('revoke-grant', { now: NOW, grant_id: consenting })).toBe(1);
    expect(statements.run('revoke-grant', { now: NOW, grant_id: revoked })).toBe(0);
    expect(grant(consenting)).toEqual(revokedAt(NOW));
    expect(grant(plain).status).toBe('active');
    untouchedRevoked();
  });

  it('revoke-all-grants: every active grant', () => {
    expect(statements.run('revoke-all-grants', { now: NOW })).toBe(2);
    expect(grant(consenting)).toEqual(revokedAt(NOW));
    expect(grant(plain)).toEqual(revokedAt(NOW));
    untouchedRevoked();
  });

  it('withdraw-consent-of-binding: consent cleared, the grant kept', () => {
    expect(statements.run('withdraw-consent-of-binding', { binding_id: g.bindingId })).toBe(1);
    expect(grant(consenting)).toEqual({ status: 'active', revoked_at: null, ...NO_CONSENT });
    expect(statements.run('withdraw-consent-of-binding', { binding_id: g.bindingId }), 'again').toBe(0);
    untouchedRevoked();
  });
});

describe('CardSyncStatements: a revoked device\'s sets and plans', () => {
  it('quarantines its open sets, cancels its plans, and touch-set moves a set\'s version by one', () => {
    const { deviceId } = fx.pairedDevice(g, 'approved');
    const set = fx.extensionSet(g, deviceId);
    const plan = fx.preparedPlan(g, set);
    const other = fx.extensionSet(g, fx.pairedDevice(g, 'approved').deviceId);
    const NOW = iso(DAY_MS);

    expect(statements.run('quarantine-sets-of-device', { device_id: deviceId })).toBe(1);
    expect(statements.run('cancel-plans-of-device', { now: NOW, device_id: deviceId })).toBe(1);
    expect(row('SELECT state, version FROM card_sync_observation_sets WHERE id = ?', set)).toEqual({ state: 'blocked-review', version: 2 });
    expect(row('SELECT status, closed_at, cancel_reason FROM card_sync_commit_plans WHERE id = ?', plan))
      .toEqual({ status: 'cancelled', closed_at: NOW, cancel_reason: 'device-revoked' });
    expect(row('SELECT state, version FROM card_sync_observation_sets WHERE id = ?', other)).toEqual({ state: 'needs-review', version: 1 });
    expect(statements.run('quarantine-sets-of-device', { device_id: deviceId }), 'again').toBe(0);

    expect(statements.run('touch-set', { set_id: other })).toBe(1);
    expect(row('SELECT version FROM card_sync_observation_sets WHERE id = ?', other)).toEqual({ version: 2 });
    expect(statements.all('set-items-page', { set_id: other, after_key: -1, limit: 100 })).toEqual([]);
    expect(statements.get('set-level-item', { set_id: other })).toBeUndefined();
    expect(statements.all('plan-effects-page', { plan_id: plan, after_ordinal: -1, limit: 500 })).toEqual([]);
  });

  it('auto-sync-step: an off always moves the revision, an on only at the version and revision read', () => {
    const revision = () => row<{ auto_sync_revision: number }>('SELECT auto_sync_revision FROM card_source_bindings WHERE id = ?', g.bindingId)
      .auto_sync_revision;
    const step = (enabled: 0 | 1, version: number | null, autoSyncRevision: number | null) => statements.run('auto-sync-step', {
      now: iso(DAY_MS), binding_id: g.bindingId, enabled, expected_version: version, expected_auto_sync_revision: autoSyncRevision,
    });
    expect(step(1, 1, 1)).toBe(1);
    expect(revision()).toBe(2);
    expect(step(1, 1, 1), 'a stale on').toBe(0);
    expect(step(0, null, null), 'an off').toBe(1);
    expect(revision()).toBe(3);
  });
});

describe('CardSyncStatements: the audit horizon', () => {
  it('writes one cutoff a day, deletes only behind it, and reports a cutoff ahead of the clock', () => {
    const old = fx.auditEvent(g, iso(-400 * DAY_MS));
    const recent = fx.auditEvent(g, iso(-300 * DAY_MS));
    const audit = (id: string) => row<{ n: number }>('SELECT count(*) AS n FROM card_sync_audit_events WHERE id = ?', id).n;

    expect(statements.get('audit-cutoff-ahead', { now: iso(0) })).toEqual({ ahead: 0 });
    expect(statements.run('audit-cutoff-refresh', { id: fx.id('card-audit-'), now: iso(0) })).toBe(1);
    expect(statements.run('audit-cutoff-refresh', { id: fx.id('card-audit-'), now: iso(DAY_MS / 2) }), 'within a day').toBe(0);
    expect(statements.run('audit-delete-chunk', { now: iso(0) })).toBe(1);
    expect([audit(old), audit(recent)]).toEqual([0, 1]);
    expect(statements.run('audit-delete-chunk', { now: iso(0) }), 'nothing more behind the horizon').toBe(0);
    expect(statements.get('audit-cutoff-ahead', { now: iso(-DAY_MS) })).toEqual({ ahead: 1 });
  });
});

describe('CardSyncStatements: reads of a file-imported row', () => {
  it('reconstructs values, history, aliases and reversibility of a v1 row', () => {
    repo.importCardTransactions({
      cardAccountId: accountId, source: 'chase-csv', parserVersion: 'csv@1.0.0',
      rows: [{
        externalIdHash: cardExternalIdHash('REF-1'), transactionDate: '2026-10-01', postedDate: '2026-10-02', status: 'posted',
        amountMinor: 1234, currency: 'USD', kind: 'purchase', description: 'SYNTHETIC COFFEE',
      }],
    });
    const [txn] = repo.listCardTransactions({ cardAccountId: accountId });
    const legacy = row<{ id: string }>("SELECT id FROM card_scopes WHERE card_account_id = ? AND kind = 'legacy'", accountId).id;

    expect(statements.all('values-at-revision', { transaction_id: txn.id, revision: 1 })).toEqual([{
      from_current: 1, at_revision: 1, status: 'posted', transaction_date: '2026-10-01', posted_date: '2026-10-02',
      amount_minor: 1234, original_amount_minor: null, original_currency: null, kind: 'purchase', description: 'SYNTHETIC COFFEE',
      merchant: null, issuer_category: null, card_scope_id: legacy, removed_reason: null, removed_from_status: null,
    }]);
    const history = statements.all('transaction-history-page', {
      transaction_id: txn.id, before_created_at: '9999-12-31T23:59:59.999Z', before_id: 'card-event-q', limit: 10,
    });
    expect(history).toHaveLength(1);
    expect(row('SELECT event_type FROM card_transaction_events WHERE id = ?', history[0].id)).toEqual({ event_type: 'created' });
    const aliases = statements.all('transaction-aliases-page', { transaction_id: txn.id, after_created_at: '', after_id: '', limit: 10 });
    expect(aliases).toHaveLength(1);
    expect(row('SELECT namespace FROM card_source_identities WHERE id = ?', aliases[0].identity_id)).toEqual({ namespace: 'legacy-file:v1' });
    expect(statements.all('transaction-merged-page', { transaction_id: txn.id, after_removed_at: '', after_id: '', limit: 10 })).toEqual([]);
    expect(statements.get('revertible-event', { transaction_id: txn.id })).toBeUndefined();
    expect(statements.get('adjustment-reversible', { value_change: 0, committed_revision: 1, transaction_id: txn.id }))
      .toEqual({ reversible: 1 });
    expect(statements.get('adjustment-reversible', { value_change: 1, committed_revision: 1, transaction_id: txn.id }))
      .toEqual({ reversible: 0 });
  });
});

describe('CardSyncStatements: index plans', () => {
  // design §5.3 R7, §3.8, §5.9: every page, the values read and the audit horizon read index ranges only, without a sort
  it.each<[CardSyncQueryName, string[]]>([
    ['set-items-page', ['idx_card_source_observations_ordinal', 'idx_card_reconciliation_suggestions_observation']],
    ['set-level-item', ['idx_card_reconciliation_suggestions_set_level']],
    ['plan-effects-page', ['sqlite_autoindex_card_sync_plan_actions_1']],
    ['transaction-history-page', ['idx_card_transaction_events_history', 'idx_card_transaction_events_moved_away']],
    ['transaction-aliases-page', ['idx_card_source_identities_page']],
    ['transaction-merged-page', ['idx_card_transactions_merged']],
    ['values-at-revision', ['sqlite_autoindex_card_transaction_versions_1', 'sqlite_autoindex_card_transactions_1']],
    ['audit-cutoff-refresh', ['idx_card_sync_audit_events_created', 'idx_card_sync_audit_events_type']],
    ['audit-delete-chunk', ['idx_card_sync_audit_events_created', 'idx_card_sync_audit_events_type']],
    ['audit-cutoff-ahead', ['idx_card_sync_audit_events_type']],
  ])('%s', (name, indexes) => {
    const params = Object.fromEntries([...CARD_SYNC_QUERIES[name].matchAll(/:(\w+)/g)].map((m) => [m[1], null]));
    const details = statements.queryPlan(name, params as never);
    const coroutines = details.filter((d) => d.startsWith('CO-ROUTINE ')).map((d) => d.split(' ')[1]);
    expect(details.filter((d) => /^SCAN /.test(d) && d !== 'SCAN CONSTANT ROW' && !coroutines.includes(d.split(' ')[1])), details.join(' | '))
      .toEqual([]);
    expect(details.filter((d) => /TEMP B-TREE/.test(d))).toEqual([]);
    for (const index of indexes) expect(details.some((d) => d.includes(index)), `${index} in ${details.join(' | ')}`).toBe(true);
  });
});
