import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CardSyncFixtures } from '../../testing/cardSyncFixtures.js';
import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice } from '../../testing/cardSyncScenario.js';
import { newCardSyncId, randomCardSyncLetters } from '../cardSyncDigests.js';
import type { CardSourceBindingView } from '../sqliteStateRepo.js';
import { cardSyncRefusalCode } from './refusals.js';

// E1b design §5.4 (runs), §4.10.1 (current-source authorization) and §6's
// C5; test D12 of §7.

let w: CardSyncScenario;
let binding: CardSourceBindingView;
let device: ScenarioDevice;

beforeEach(() => {
  w = new CardSyncScenario();
  w.enable('chase');
  binding = w.binding();
  device = w.device([binding.bindingId]);
});

afterEach(() => {
  w.close();
});

const TABLES = ['card_sync_runs', 'card_sync_commit_plans', 'card_sync_observation_sets', 'card_sync_audit_events'];
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
const runInput = (overrides: Record<string, unknown> = {}) => ({
  deviceId: device.deviceId, clientRunId: `crn_${randomCardSyncLetters()}`, bindingId: binding.bindingId, bindingVersion: 1,
  adapterVersion: 'holdr-ext-chase@0.1.0', contractVersion: 1, trigger: 'manual' as const, expectedGeneration: w.generation(),
  ...overrides,
});

describe('opening a run (§5.4, §4.10.1)', () => {
  it('opens a run for 600 s, idempotent on its client run id (C5)', () => {
    const input = runInput();
    const first = w.repo.createCardSyncRun(input);
    expect(first).toEqual({ runId: expect.stringMatching(/^run_[a-p]{32}$/), uploadExpiresAt: '2026-10-17T10:10:00.000Z', replayed: false });
    expect(w.repo.createCardSyncRun(input)).toEqual({ ...first, replayed: true });
    for (const change of [{ trigger: 'auto' as const }, { adapterVersion: 'holdr-ext-chase@0.2.0' }]) {
      refused('idempotency-conflict', () => w.repo.createCardSyncRun({ ...input, ...change }));
    }
    expect(w.repo.getCardSyncRun(first.runId)).toMatchObject({
      runId: first.runId, deviceId: device.deviceId, clientRunId: input.clientRunId, bindingId: binding.bindingId, bindingVersion: 1,
      cardAccountId: binding.cardAccountRef, trigger: 'manual', createdAt: w.now(), runState: 'open', errorCode: null,
      abortReason: null, acceptedAt: null, payloadDigest: null, observationSetId: null, setState: null,
    });
    expect(w.db.prepare("SELECT count(*) FROM card_sync_audit_events WHERE event_type = 'run-created'").pluck().get()).toBe(1);
  });

  it('refuses whatever the current-source authorization refuses, writing nothing', () => {
    refused('principal-not-allowed', () => w.repo.createCardSyncRun(runInput({ deviceId: 'dev_1' })));
    for (const bad of [{ clientRunId: 'crn_1' }, { adapterVersion: '-bad' }, { trigger: 'scheduled' }, { bindingVersion: 0 }]) {
      refused('invalid-request', () => w.repo.createCardSyncRun(runInput(bad)));
    }
    refused('contract-unsupported', () => w.repo.createCardSyncRun(runInput({ contractVersion: 2 })));
    refused('not-found', () => w.repo.createCardSyncRun(runInput({ bindingId: newCardSyncId('bnd_') })));
    refused('generation-mismatch', () => w.repo.createCardSyncRun(runInput({ expectedGeneration: newCardSyncId('agn_') })));
    refused('binding-stale', () => w.repo.createCardSyncRun(runInput({ bindingVersion: 2 })));
    const other = w.binding();
    refused('binding-stale', () => w.repo.createCardSyncRun(runInput({ bindingId: other.bindingId })));

    w.repo.pauseCardSync({ actorRef: SCENARIO_OWNER, ...w.step() });
    refused('sync-paused', () => w.repo.createCardSyncRun(runInput()));
    w.repo.resumeCardSync({ expectedVersion: w.repo.getCardSyncSettings().settingsVersion, actorRef: SCENARIO_OWNER, ...w.step() });
    w.repo.disableCardSyncIssuer({ issuer: 'chase', actorRef: SCENARIO_OWNER, ...w.step() });
    refused('issuer-disabled', () => w.repo.createCardSyncRun(runInput()));
    w.enable('chase');
    w.repo.confirmCardSourceBinding({ bindingId: binding.bindingId, expectedVersion: 1, label: binding.bindingLabel, regrantDeviceIds: [],
      actorRef: SCENARIO_OWNER, ...w.step(), scopes: binding.scopes.filter((s) => s.kind === 'known')
        .map((s) => ({ cardScopeId: s.cardScopeId, label: s.scopeLabel, holderAlias: s.holderAlias as 'alex', last4: s.last4 })) });
    refused('binding-stale', () => w.repo.createCardSyncRun(runInput({ bindingVersion: 2 })));
    w.db.prepare(`UPDATE card_source_bindings SET status = 'needs-reconfirmation', status_reason = 'restored-from-backup',
      version = version + 1 WHERE id = ?`).run(binding.bindingId);
    refused('binding-needs-reconfirmation', () => w.repo.createCardSyncRun(runInput({ bindingVersion: 3 })));
    w.repo.retireCardSourceBinding({ bindingId: binding.bindingId, expectedVersion: 3, actorRef: SCENARIO_OWNER, ...w.step() });
    refused('binding-retired', () => w.repo.createCardSyncRun(runInput({ bindingVersion: 4 })));
  });

  it('refuses a device that is not active, and an Amex MAIN-world source without MAIN consent', () => {
    w.repo.revokeCardSyncDevice({ deviceId: device.deviceId, reason: 'owner', actor: { kind: 'session', actorRef: SCENARIO_OWNER },
      ...w.step() });
    refused('device-not-active', () => w.repo.createCardSyncRun(runInput()));
    const live = w.device([binding.bindingId]);
    w.tick(30 * 86_400);
    refused('device-not-active', () => w.repo.createCardSyncRun(runInput({ deviceId: live.deviceId })));

    w.enable('amex');
    const amex = w.binding({ source: 'amex-api-recent' });
    const browser = w.device([amex.bindingId]);
    const amexRun = { deviceId: browser.deviceId, bindingId: amex.bindingId };
    expect(w.repo.createCardSyncRun(runInput(amexRun)).replayed).toBe(false);
    w.db.prepare("UPDATE card_sync_issuer_policy SET main_passive_accepted = 0, enabled = 0, enabled_at = NULL, revision = revision + 1 WHERE id = 'amex'").run();
    refused('issuer-disabled', () => w.repo.createCardSyncRun(runInput(amexRun)));
  });

  it('keeps at most two open runs per device and max_runs_per_device_day a day', () => {
    w.repo.createCardSyncRun(runInput());
    w.repo.createCardSyncRun(runInput());
    refused('too-many-open-runs', () => w.repo.createCardSyncRun(runInput()));
    w.tick(600);
    w.repo.createCardSyncRun(runInput());
    const settings = w.repo.getCardSyncSettings();
    w.repo.updateCardSyncRetention({ expectedVersion: settings.settingsVersion, quotas: { maxRunsPerDeviceDay: 4 }, actorRef: SCENARIO_OWNER });
    w.repo.createCardSyncRun(runInput());
    w.tick(600);
    refused('run-rate-limited', () => w.repo.createCardSyncRun(runInput()));
    w.tick(86_400 - 600);
    expect(w.repo.createCardSyncRun(runInput()).replayed).toBe(false);
  });
});

describe('refusals, aborts and receipts of runs (§5.4; D12)', () => {
  it('finds a refused upload by the device-scoped client run id, without writes or a history scan', () => {
    const input = runInput();
    const run = w.repo.createCardSyncRun(input);
    const other = w.device([binding.bindingId]);
    const before = dump();
    expect(w.repo.getCardSyncRunByClientRunId(input)).toEqual(w.repo.getCardSyncRun(run.runId));
    expect(w.repo.getCardSyncRunByClientRunId({ deviceId: other.deviceId, clientRunId: input.clientRunId })).toBeNull();
    for (const clientRunId of ['crn_bad', '', `crn_${'z'.repeat(32)}`]) {
      expect(w.repo.getCardSyncRunByClientRunId({ deviceId: device.deviceId, clientRunId })).toBeNull();
    }
    expect(w.repo.getCardSyncRunByClientRunId({ deviceId: 'bad', clientRunId: input.clientRunId })).toBeNull();
    expect(dump()).toEqual(before);
    const detail = w.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM card_sync_runs WHERE device_id = ? AND client_run_id = ?')
      .all(device.deviceId, input.clientRunId) as Array<{ detail: string }>;
    expect(detail.some((row) => row.detail.includes('idx_card_sync_runs_client'))).toBe(true);
  });

  /** An accepted run with its set and the owner's prepared plan, as acceptance and prepare leave them. */
  function acceptedRun() {
    const fx = new CardSyncFixtures(w.db, w.clock);
    const runId = w.repo.createCardSyncRun(runInput()).runId;
    w.db.prepare(`UPDATE card_sync_runs SET acceptance_state = 'accepted', payload_digest = ?, accepted_at = ?, closed_at = ? WHERE id = ?`)
      .run(fx.digest('pd1:'), w.now(), w.now(), runId);
    const g = { usr: SCENARIO_OWNER, accountId: binding.cardAccountRef, knownScopeId: binding.scopes[0].cardScopeId,
      bindingId: binding.bindingId, generation: w.generation() };
    const setId = fx.extensionSet(g, device.deviceId, { run_id: runId });
    const planId = fx.preparedPlan(g, setId);
    return { runId, setId, planId };
  }

  it('records E2\'s refusal on an open run only', () => {
    const runId = w.repo.createCardSyncRun(runInput()).runId;
    refused('invalid-request', () => w.repo.recordCardSyncRunRefusal({ deviceId: device.deviceId, runId, code: 'too-big' as never }));
    const other = w.device([binding.bindingId]);
    refused('run-not-found', () => w.repo.recordCardSyncRunRefusal({ deviceId: other.deviceId, runId, code: 'card-data' }));
    expect(w.repo.recordCardSyncRunRefusal({ deviceId: device.deviceId, runId, code: 'card-data' })).toBe(true);
    expect(w.repo.getCardSyncRun(runId)).toMatchObject({ runState: 'refused', errorCode: 'card-data' });
    expect(w.repo.recordCardSyncRunRefusal({ deviceId: device.deviceId, runId, code: 'too-large' })).toBe(false);
    const accepted = acceptedRun();
    expect(w.repo.recordCardSyncRunRefusal({ deviceId: device.deviceId, runId: accepted.runId, code: 'card-data' })).toBe(false);
    expect(w.repo.getCardSyncRun(accepted.runId)).toMatchObject({ runState: 'accepted', errorCode: null });
  });

  it('stores each of the five reasons on an open run, and on an accepted run cancels its plans but keeps the set (D12)', () => {
    for (const reason of ['site-permission-revoked', 'not-signed-in', 'unknown-page-structure', 'certificate-error', 'user-cancelled'] as const) {
      const runId = w.repo.createCardSyncRun(runInput()).runId;
      expect(w.repo.abortCardSyncRun({ deviceId: device.deviceId, runId, reason })).toMatchObject({ runState: 'aborted', abortReason: reason });
      expect(w.repo.abortCardSyncRun({ deviceId: device.deviceId, runId, reason }).runState).toBe('aborted');
      refused('run-closed', () => w.repo.abortCardSyncRun({ deviceId: device.deviceId, runId,
        reason: reason === 'user-cancelled' ? 'not-signed-in' : 'user-cancelled' }));
      w.tick(1);
    }
    refused('invalid-request', () => w.repo.abortCardSyncRun({ deviceId: device.deviceId, runId: newCardSyncId('run_'), reason: 'tab-closed' as never }));
    const { runId, setId, planId } = acceptedRun();
    const view = w.repo.abortCardSyncRun({ deviceId: device.deviceId, runId, reason: 'user-cancelled' });
    expect(view).toMatchObject({ runState: 'accepted', abortReason: 'user-cancelled', observationSetId: setId, setState: 'needs-review' });
    expect(w.db.prepare('SELECT status, cancel_reason FROM card_sync_commit_plans WHERE id = ?').get(planId))
      .toEqual({ status: 'cancelled', cancel_reason: 'aborted' });
    expect(w.db.prepare('SELECT state, closed_at FROM card_sync_observation_sets WHERE id = ?').get(setId))
      .toEqual({ state: 'needs-review', closed_at: null });
    expect(w.repo.abortCardSyncRun({ deviceId: device.deviceId, runId, reason: 'user-cancelled' }).abortReason).toBe('user-cancelled');
    refused('run-closed', () => w.repo.abortCardSyncRun({ deviceId: device.deviceId, runId, reason: 'not-signed-in' }));
    const refusedRun = w.repo.createCardSyncRun(runInput()).runId;
    w.repo.recordCardSyncRunRefusal({ deviceId: device.deviceId, runId: refusedRun, code: 'card-data' });
    refused('run-closed', () => w.repo.abortCardSyncRun({ deviceId: device.deviceId, runId: refusedRun, reason: 'user-cancelled' }));
  });

  it('shows a device only its own runs; the owner and the service token see any, newest first in pages', () => {
    const runs = Array.from({ length: 3 }, () => { const id = w.repo.createCardSyncRun(runInput()).runId; w.tick(700); return id; });
    const other = w.device([binding.bindingId]);
    expect(w.repo.getCardSyncRunReceipt({ principal: { kind: 'device', deviceId: device.deviceId }, runId: runs[0] }).runId).toBe(runs[0]);
    refused('run-not-found', () => w.repo.getCardSyncRunReceipt({ principal: { kind: 'device', deviceId: other.deviceId }, runId: runs[0] }));
    expect(w.repo.getCardSyncRunReceipt({ principal: { kind: 'session', actorRef: SCENARIO_OWNER }, runId: runs[1] }).runId).toBe(runs[1]);
    expect(w.repo.getCardSyncRunReceipt({ principal: { kind: 'service' }, runId: runs[2] }).runId).toBe(runs[2]);
    refused('run-not-found', () => w.repo.getCardSyncRunReceipt({ principal: { kind: 'service' }, runId: newCardSyncId('run_') }));
    const first = w.repo.listCardSyncRuns({ deviceId: device.deviceId, limit: 2 });
    expect(first.runs.map((r) => r.runId)).toEqual([runs[2], runs[1]]);
    const second = w.repo.listCardSyncRuns({ deviceId: device.deviceId, limit: 2, after: first.next });
    expect(second).toEqual({ runs: [expect.objectContaining({ runId: runs[0] })], next: null });
    expect(w.repo.listCardSyncRuns({ deviceId: other.deviceId, limit: 50 }).runs).toEqual([]);
    expect(w.repo.listCardSyncRuns({ cardAccountId: binding.cardAccountRef, bindingId: binding.bindingId, limit: 50 }).runs).toHaveLength(3);
    for (const bad of [{ limit: 0 }, { limit: 51 }, { limit: 5, after: { createdAt: 'x', runId: runs[0] } }, { limit: 5, deviceId: 'dev_1' }]) {
      refused('invalid-request', () => w.repo.listCardSyncRuns(bad as never));
    }
  });
});
