import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import type { CardSourceBindingView } from '../sqliteStateRepo.js';
import { cardSyncRefusalCode } from './refusals.js';

// E1b design §5.4 (acceptance, receipts, rehydration), §4.5 (first items),
// §6's C4 and tests C22/D11, I24 of §7.

let w: CardSyncScenario;
let binding: CardSourceBindingView;
let device: ScenarioDevice;
let known: string[];
let unknown: string;

beforeEach(() => {
  w = new CardSyncScenario();
  w.enable('chase');
  binding = w.binding();
  device = w.device([binding.bindingId]);
  ({ known, unknown } = w.scopes(binding));
});

afterEach(() => {
  w.close();
});

const TABLES = ['card_sync_runs', 'card_sync_observation_sets', 'card_source_observations', 'card_observation_secondary_ids',
  'card_coverage_windows', 'card_sync_payload_receipts', 'card_reconciliation_suggestions', 'card_reconciliation_candidates',
  'card_sync_set_card_hints', 'card_transactions', 'card_source_identities', 'card_identity_contents', 'card_transaction_events'];
const dump = () => Object.fromEntries(TABLES.map((t) => [t, w.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
function refused(code: string, write: () => unknown): void {
  const before = dump();
  let error: unknown;
  try {
    write();
  } catch (caught) {
    error = caught;
  }
  expect(cardSyncRefusalCode(error), String(error)).toBe(code);
  expect(dump()).toEqual(before);
}
const count = (sql: string, ...params: unknown[]) => w.db.prepare(sql).pluck().get(...params) as number;

const rows = (): ScenarioRow[] => [
  { scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE', merchant: 'Fourth Coffee', id: 'sor-1' },
  { scope: known[0], date: '2026-10-02', amount: 4999, description: 'CONTOSO MARKET', id: 'sor-2',
    secondary: [['chase-api:derived:v1', 'derived-2']] },
  { scope: known[1], date: '2026-10-03', status: 'pending', amount: 800, description: 'NORTHWIND PARKING', id: 'sor-3' },
];

describe('accepting an upload (§5.4)', () => {
  it('stores the set, observations, coverage, hints and receipt, writes no ledger row, and closes the run', () => {
    const { receipt, payload, runId } = w.accept(device, binding, rows(), { cards: ['1111', '2222'] });
    expect(receipt).toEqual({
      runId, observationSetId: expect.stringMatching(/^obs_[a-p]{32}$/), payloadDigest: expect.stringMatching(/^pd1:/),
      acceptedAt: w.now(), expiresAt: '2026-11-16T10:00:00.000Z', rowCount: 3, reviewCount: 0, state: 'accepted-uncommitted',
      replayed: false,
    });
    const set = w.db.prepare('SELECT * FROM card_sync_observation_sets WHERE id = ?').get(receipt.observationSetId) as Record<string, unknown>;
    expect(set).toMatchObject({
      origin: 'extension', run_id: runId, device_id: device.deviceId, binding_id: binding.bindingId, binding_version: 1,
      capture_id: payload.captureId, contract_version: 1, mode: 'isolated-read', source: 'chase-api', state: 'accepted-uncommitted',
      version: 1, review_ledger_revision: 0, row_count: 3, open_count: 3, receipt_state: 'kept', statement_present: 0,
    });
    expect(w.db.prepare('SELECT ordinal, last4 FROM card_sync_set_card_hints ORDER BY ordinal').all())
      .toEqual([{ ordinal: 0, last4: '1111' }, { ordinal: 1, last4: '2222' }]);
    expect(count('SELECT count(*) FROM card_source_observations WHERE state = ?', 'open')).toBe(3);
    expect(count('SELECT count(*) FROM card_observation_secondary_ids')).toBe(1);
    expect(w.db.prepare(`SELECT entry_ordinal, status, claimed_completeness, verified_completeness, ledger_state, evidence
      FROM card_coverage_windows ORDER BY entry_ordinal`).all()).toEqual([
      { entry_ordinal: 0, status: 'posted', claimed_completeness: 'partial', verified_completeness: 'partial',
        ledger_state: 'observed-uncommitted', evidence: 'extension-claimed' },
      { entry_ordinal: 1, status: 'pending', claimed_completeness: 'partial', verified_completeness: 'partial',
        ledger_state: 'observed-uncommitted', evidence: 'extension-claimed' },
    ]);
    expect(count('SELECT count(*) FROM card_transactions')).toBe(0);
    expect(w.repo.getCardSyncRun(runId)).toMatchObject({ runState: 'accepted', payloadDigest: receipt.payloadDigest,
      observationSetId: receipt.observationSetId });
    expect(count("SELECT count(*) FROM card_sync_audit_events WHERE event_type = 'set-accepted' AND row_count = 3")).toBe(1);
    const rebuilt = w.repo.rehydrateCardSyncPayload(receipt.observationSetId);
    expect(rebuilt).toEqual({ ok: true, payload });
  });

  it('answers a lost ACK with the stored receipt and refuses other bytes for the run (C4)', () => {
    const runId = w.run(device, binding);
    const payload = w.payload(binding, rows());
    const clientRunId = w.repo.getCardSyncRun(runId)!.clientRunId;
    const input = { deviceId: device.deviceId, runId, clientRunId, ...CardSyncScenario.wire(payload), expectedGeneration: w.generation() };
    const first = w.repo.acceptCardSyncObservations(input);
    w.tick(3600);
    expect(w.repo.acceptCardSyncObservations(input)).toEqual({ ...first, replayed: true });
    const other = CardSyncScenario.wire(w.payload(binding, rows().slice(0, 2)));
    refused('idempotency-conflict', () => w.repo.acceptCardSyncObservations({ ...input, ...other }));
    refused('idempotency-conflict', () => w.repo.acceptCardSyncObservations({ ...input, clientRunId: `crn_${'a'.repeat(32)}` }));
    expect(count('SELECT count(*) FROM card_sync_observation_sets')).toBe(1);
  });

  it('creates the first review items: capture rows, unknown scopes and a statement that disagrees (§4.5)', () => {
    const { receipt } = w.accept(device, binding, [
      { scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE' },
      { scope: unknown, date: '2026-10-02', amount: 300, description: 'TAILSPIN TOYS', id: 'sor-9' },
      { scope: known[0], date: '2026-10-04', amount: 700, description: 'LITWARE', id: 'sor-10' },
    ], { statement: { chargesMinor: 99_999, creditsMinor: null, netMinor: null, previousBalanceMinor: null, newBalanceMinor: null } });
    expect(receipt).toMatchObject({ state: 'needs-review', reviewCount: 3 });
    expect(w.db.prepare(`SELECT o.ordinal, r.reason, r.category, r.allowed_actions, r.difference_field, r.expected_minor, r.actual_minor
      FROM card_reconciliation_suggestions r LEFT JOIN card_source_observations o ON o.id = r.observation_id
      ORDER BY coalesce(o.ordinal, -1)`).all()).toEqual([
      { ordinal: null, reason: 'statement-mismatch', category: 'reconciliation-difference', allowed_actions: 64, difference_field: 'charges',
        expected_minor: 99_999, actual_minor: 2250 },
      { ordinal: 0, reason: 'no-stable-id', category: 'no-stable-id', allowed_actions: 136, difference_field: null, expected_minor: null,
        actual_minor: null },
      { ordinal: 1, reason: 'unknown-scope', category: 'scope-unknown', allowed_actions: 140, difference_field: null, expected_minor: null,
        actual_minor: null },
    ]);
    expect(w.db.prepare('SELECT review_ledger_revision, state FROM card_sync_observation_sets').get())
      .toEqual({ review_ledger_revision: 0, state: 'needs-review' });
  });

  it('re-validates the bytes, the binding, the scopes and the capture (§5.4 step 3)', () => {
    const elsewhere = w.scopes(w.binding()).known[0];
    const runId = w.run(device, binding);
    const clientRunId = w.repo.getCardSyncRun(runId)!.clientRunId;
    const payload = w.payload(binding, rows());
    const wire = CardSyncScenario.wire(payload);
    const base = { deviceId: device.deviceId, runId, clientRunId, expectedGeneration: w.generation() };
    refused('payload-invalid', () => w.repo.acceptCardSyncObservations({ ...base, ...wire, canonicalJson: '{"format":' }));
    refused('payload-digest-mismatch', () => w.repo.acceptCardSyncObservations({ ...base, ...wire,
      canonicalJson: wire.canonicalJson.replace('{', '{ ') }));
    refused('payload-digest-mismatch', () => w.repo.acceptCardSyncObservations({ ...base, canonicalJson: wire.canonicalJson,
      payloadDigest: CardSyncScenario.wire(w.payload(binding, rows().slice(1))).payloadDigest }));
    refused('scope-not-in-binding', () => w.repo.acceptCardSyncObservations({ ...base,
      ...CardSyncScenario.wire(w.payload(binding, [...rows(), { scope: elsewhere, date: '2026-10-05', amount: 5, description: 'X', id: 'x' }])) }));
    w.repo.acceptCardSyncObservations({ ...base, ...wire });
    const second = w.run(device, binding);
    const replay = { deviceId: device.deviceId, runId: second, clientRunId: w.repo.getCardSyncRun(second)!.clientRunId,
      expectedGeneration: w.generation() };
    refused('capture-already-accepted', () => w.repo.acceptCardSyncObservations({ ...replay, ...wire }));
  });

  it('refuses a run past its window, a paused source and a device that is not the run\'s', () => {
    const runId = w.run(device, binding);
    const clientRunId = w.repo.getCardSyncRun(runId)!.clientRunId;
    const input = () => ({ deviceId: device.deviceId, runId, clientRunId, ...CardSyncScenario.wire(w.payload(binding, rows())),
      expectedGeneration: w.generation() });
    const other = w.device([binding.bindingId]);
    refused('run-not-found', () => w.repo.acceptCardSyncObservations({ ...input(), deviceId: other.deviceId }));
    w.repo.pauseCardSync({ actorRef: SCENARIO_OWNER, ...w.step() });
    refused('sync-paused', () => w.repo.acceptCardSyncObservations(input()));
    w.repo.resumeCardSync({ expectedVersion: w.repo.getCardSyncSettings().settingsVersion, actorRef: SCENARIO_OWNER, ...w.step() });
    w.tick(601);
    refused('run-expired', () => w.repo.acceptCardSyncObservations(input()));
  });

  it('charges review quotas per account, device and globally, receipts included (I24)', () => {
    const settings = w.repo.getCardSyncSettings();
    w.repo.updateCardSyncRetention({ expectedVersion: settings.settingsVersion, quotas: { accountSets: 1 }, actorRef: SCENARIO_OWNER });
    w.accept(device, binding, rows());
    const runId = w.run(device, binding);
    const input = { deviceId: device.deviceId, runId, clientRunId: w.repo.getCardSyncRun(runId)!.clientRunId,
      ...CardSyncScenario.wire(w.payload(binding, rows())), expectedGeneration: w.generation() };
    refused('review-quota-exceeded', () => w.repo.acceptCardSyncObservations(input));
  });

  it('serves the receipt for its retention, then answers receipt-expired; the owner may delete it early', () => {
    const { receipt } = w.accept(device, binding, rows());
    const stored = w.repo.getCardSyncPayloadReceipt({ setId: receipt.observationSetId });
    expect(stored).toMatchObject({ payloadDigest: receipt.payloadDigest, acceptedAt: receipt.acceptedAt,
      expiresAt: '2026-10-24T10:00:00.000Z' });
    w.tick(7 * 86_400);
    refused('receipt-expired', () => w.repo.getCardSyncPayloadReceipt({ setId: receipt.observationSetId }));
    w.repo.deleteCardSyncReceipt({ setId: receipt.observationSetId, actorRef: SCENARIO_OWNER });
    expect(w.db.prepare('SELECT receipt_state, version FROM card_sync_observation_sets').get()).toEqual({ receipt_state: 'deleted', version: 2 });
    expect(count('SELECT count(*) FROM card_sync_payload_receipts')).toBe(0);
    w.repo.deleteCardSyncReceipt({ setId: receipt.observationSetId, actorRef: SCENARIO_OWNER });
    expect(w.repo.rehydrateCardSyncPayload(receipt.observationSetId).ok).toBe(true);
  });
});
