import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import { newCardSyncId, pairingCodeDigest, randomCardSyncLetters } from '../cardSyncDigests.js';
import type { CardSourceBindingView } from '../sqliteStateRepo.js';
import { cardSyncRefusalCode } from './refusals.js';

// E1b design §5.8 (recovery invalidation), §5.9 (retention phases), §5.10
// (coverage), tests D20–D23, R1–R12 and the read side of C3 in §7.

let w: CardSyncScenario;
let binding: CardSourceBindingView;
let device: ScenarioDevice;
let known: string[];

beforeEach(() => {
  w = new CardSyncScenario();
  w.enable('chase');
  binding = w.binding();
  device = w.device([binding.bindingId]);
  ({ known } = w.scopes(binding));
});

afterEach(() => {
  w.close();
});

const count = (sql: string, ...params: unknown[]) => w.db.prepare(sql).pluck().get(...params) as number;
const DAY = 86_400;
const capture = (i: number): ScenarioRow => ({ scope: known[0], date: '2026-10-01', amount: 100 + i, description: `CAPTURE ${i}` });
const coffee = (): ScenarioRow => ({ scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE', id: 'sor-1' });
function refused(code: string, write: () => unknown): void {
  let error: unknown;
  try {
    write();
  } catch (caught) {
    error = caught;
  }
  expect(cardSyncRefusalCode(error), String(error)).toBe(code);
}
const ledger = () => ({
  rows: w.db.prepare('SELECT * FROM card_transactions ORDER BY rowid').all(),
  identities: w.db.prepare('SELECT * FROM card_source_identities ORDER BY rowid').all(),
  events: count('SELECT count(*) FROM card_transaction_events'),
});
function settle(): Array<ReturnType<typeof w.repo.runCardSyncRetention>> {
  const calls = [];
  for (let i = 0; i < 50; i += 1) {
    const report = w.repo.runCardSyncRetention();
    calls.push(report);
    if (report.done) return calls;
  }
  throw new Error('retention never finished');
}

describe('recovery invalidation (§5.8)', () => {
  it('closes every authority at once and leaves the ledger, file sets and receipts alone (D20)', () => {
    w.ingest(device, binding, [coffee()]);
    const open = w.accept(device, binding, [capture(1)]).receipt;
    w.run(device, binding);
    const pending = w.repo.createCardSyncPairing({ actorRef: SCENARIO_OWNER, codeDigest: pairingCodeDigest(randomCardSyncLetters()),
      bindingIds: [binding.bindingId], replacesDeviceId: null, ...w.step() }).value;
    const before = ledger();
    const next = newCardSyncId('agn_');
    const report = w.repo.invalidateAllCardSyncAuthorization({ nextGeneration: next });
    expect(report).toMatchObject({ pairingsCancelled: 1, devicesRevoked: 1, runsExpired: 1, bindingsToReconfirm: 1,
      setsToRecoveryReview: 1, issuersDisabled: 1, authorizationGeneration: next });
    expect(report.grantsRevoked).toBeGreaterThanOrEqual(1);
    expect(w.generation()).toBe(next);
    expect(w.repo.getCardSyncSettings()).toMatchObject({ paused: true });
    expect(w.repo.getCardSourceBinding(binding.bindingId)).toMatchObject({ status: 'needs-reconfirmation',
      statusReason: 'restored-from-backup', bindingVersion: 2 });
    expect(w.repo.getCardSyncDevice(device.deviceId)).toMatchObject({ status: 'revoked' });
    expect(w.repo.getCardSyncPairing(pending.pairingId)).toMatchObject({ status: 'cancelled' });
    expect(w.db.prepare('SELECT state, expires_at FROM card_sync_observation_sets WHERE id = ?').get(open.observationSetId))
      .toEqual({ state: 'recovery-review', expires_at: open.expiresAt });
    expect(ledger()).toEqual(before);
    expect(count('SELECT count(*) FROM card_sync_payload_receipts')).toBe(2);
    expect(count("SELECT count(*) FROM card_sync_audit_events WHERE event_type = 'recovery-completed' AND actor_kind = 'recovery'"))
      .toBe(1);
    refused('invalid-request', () => w.repo.invalidateAllCardSyncAuthorization({ nextGeneration: next }));
  });
});

describe('retention (§5.9)', () => {
  it('expires a due set in chunks, moving its version each chunk, then closes it; never touching the ledger (R10, R11, R6)', () => {
    w.ingest(device, binding, [coffee()]);
    const due = w.accept(device, binding, Array.from({ length: 250 }, (_, i) => capture(i))).receipt;
    expect(due.reviewCount).toBe(250);
    const before = ledger();
    const page = w.repo.getCardSyncObservationSetPage({ setId: due.observationSetId, after: null, limit: 100 })!;
    w.tick(30 * DAY);
    // Past the deadline every method already treats the set as expired, whatever retention has done.
    expect(w.repo.refreshCardReviewItems({ setId: due.observationSetId })).toMatchObject({ changed: false, expired: true });
    const first = w.repo.runCardSyncRetention({ budgetMs: 1 });
    expect(first.done).toBe(false);
    expect(first.expiringSets).toBe(1);
    const calls = settle();
    expect(calls.at(-1)).toMatchObject({ done: true, expiringSets: 0 });
    const set = w.db.prepare('SELECT * FROM card_sync_observation_sets WHERE id = ?').get(due.observationSetId) as Record<string, number>;
    // Accepted, 3 chunks of up to 100 rows, closed; receipt given up; content purged in chunks: each moved the version.
    expect(set).toMatchObject({ state: 'expired-unreviewed', expired_count: 250, open_count: 0, receipt_state: 'expired' });
    expect(set.version).toBeGreaterThanOrEqual(1 + 3 + 1 + 1 + 3 + 1);
    expect(set.content_purged_at).not.toBeNull();
    expect(count('SELECT count(*) FROM card_source_observations WHERE observation_set_id = ?', due.observationSetId)).toBe(0);
    expect(count('SELECT count(*) FROM card_sync_payload_receipts WHERE observation_set_id = ?', due.observationSetId)).toBe(0);
    expect(count("SELECT count(*) FROM card_coverage_windows WHERE ledger_state = 'expired-unreviewed'")).toBe(1);
    expect(ledger()).toEqual(before);
    refused('page-stale', () => w.repo.getCardSyncObservationSetPage({ setId: due.observationSetId, after: page.next, limit: 100 }));
  });

  it('expires plans, runs, pairings and devices on time, and deletes closed plans after 7 days and metadata after 365 (R1–R5)', () => {
    const { receipt } = w.accept(device, binding, [coffee()]);
    const plan = w.repo.prepareCardSyncPlan({ principal: { kind: 'session', actorRef: SCENARIO_OWNER }, setId: receipt.observationSetId,
      expectedVersion: 1, expectedGeneration: w.generation() });
    expect(plan.status).toBe('executable');
    w.run(device, binding);
    w.tick(601);
    settle();
    expect(count("SELECT count(*) FROM card_sync_commit_plans WHERE status = 'expired'")).toBe(1);
    expect(count("SELECT count(*) FROM card_sync_runs WHERE acceptance_state = 'expired'")).toBe(1);
    w.tick(7 * DAY);
    settle();
    expect(count('SELECT count(*) FROM card_sync_commit_plans')).toBe(0);
    // The device's 30 days run out: expired, grants revoked with their consent, its open set left for the owner.
    w.tick(30 * DAY);
    settle();
    expect(w.repo.getCardSyncDevice(device.deviceId)).toMatchObject({ status: 'expired' });
    expect(count("SELECT count(*) FROM card_sync_device_scopes WHERE device_id = ? AND status = 'active'", device.deviceId)).toBe(0);
    w.tick(400 * DAY);
    settle();
    expect(count("SELECT count(*) FROM card_sync_audit_events WHERE event_type <> 'retention-completed'")).toBe(0);
    expect(count('SELECT count(*) FROM card_sync_observation_sets')).toBe(0);
    expect(count('SELECT count(*) FROM card_sync_runs')).toBe(0);
    expect(count('SELECT count(*) FROM card_sync_devices')).toBe(0);
    expect(count('SELECT count(*) FROM card_sync_pairings')).toBe(0);
  });

  it('keeps provenance forever: a committed set keeps its provenance rows, run and committed coverage', () => {
    const setId = w.ingest(device, binding, [coffee()]);
    w.tick(500 * DAY);
    settle();
    expect(count('SELECT count(*) FROM card_sync_observation_sets WHERE id = ?', setId)).toBe(1);
    expect(count('SELECT count(*) FROM card_source_observations WHERE observation_set_id = ? AND provenance = 1', setId)).toBe(1);
    expect(count("SELECT count(*) FROM card_coverage_windows WHERE ledger_state = 'committed'")).toBe(1);
    expect(count('SELECT count(*) FROM card_sync_runs')).toBe(1);
    expect(w.db.prepare('SELECT content_purged_at IS NOT NULL FROM card_sync_observation_sets').pluck().get()).toBe(1);
  });
});

describe('coverage (§5.10)', () => {
  it('lists windows by ledger state and merges only equal committed windows', () => {
    w.ingest(device, binding, [coffee()]);
    w.ingest(device, binding, [{ ...coffee(), id: 'sor-2', date: '2026-10-02', amount: 2 }]);
    w.accept(device, binding, [{ ...coffee(), id: 'sor-9', date: '2026-10-20', amount: 9 }]);
    expect(w.repo.listCardCoverageWindows({ cardAccountId: binding.cardAccountRef }).map((c) => c.ledgerState).sort())
      .toEqual(['committed', 'committed', 'observed-uncommitted']);
    expect(w.repo.mergedCardCoverage({ cardAccountId: binding.cardAccountRef })).toEqual([{
      cardScopeId: known[0], source: 'chase-api', status: 'posted', basis: 'transaction', evidence: 'extension-claimed',
      verifiedCompleteness: 'partial', start: '2026-10-01', end: '2026-10-02', windows: 2,
    }]);
  });
});
